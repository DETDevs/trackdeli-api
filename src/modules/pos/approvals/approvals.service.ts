import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcrypt';
import { CreateApprovalDto } from './dto/create-approval.dto';

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);
  private readonly TOKEN_EXPIRATION_MINUTES = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService
  ) {}

  async createToken(
    businessId: string,
    dto: CreateApprovalDto,
    cashierId: string,
    cashierRole: string
  ): Promise<string> {
    // Rate limiting: 5 failed attempts in 15 mins by terminal/email
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const recentFailures = await this.prisma.posAuditLog.count({
      where: {
        businessId,
        action: 'APPROVAL_ATTEMPT_FAILED',
        entityId: dto.cashRegisterId,
        createdAt: { gte: fifteenMinsAgo },
        OR: [
          { userId: cashierId },
          { reason: { contains: dto.approverEmail } }
        ]
      }
    });

    if (recentFailures >= 5) {
      this.throwError('APPROVAL_LOCKED', 'Demasiados intentos fallidos. Intente más tarde.');
    }


    const approver = await this.prisma.user.findFirst({
      where: {
        email: dto.approverEmail,
        businessId,
        isActive: true,
        role: { in: ['ENCARGADO', 'SUPERADMIN'] }
      }
    });

    if (!approver) {
      await this.auditService.record({
        businessId,
        userId: cashierId,
        userRole: cashierRole,
        action: 'APPROVAL_ATTEMPT_FAILED',
        entityType: 'User',
        entityId: dto.cashRegisterId,
        reason: `Usuario de aprobación no encontrado o sin permisos: ${dto.approverEmail}`,
      });
      this.throwError('APPROVAL_DENIED', 'Credenciales incorrectas o usuario no autorizado.');
    }

    const isPasswordValid = approver.passwordHash ? await bcrypt.compare(dto.approverPassword, approver.passwordHash) : false;

    if (!isPasswordValid) {
      await this.auditService.record({
        businessId,
        userId: approver.id,
        userRole: approver.role,
        action: 'APPROVAL_ATTEMPT_FAILED',
        entityType: 'CashRegister',
        entityId: dto.cashRegisterId,
        reason: `Contraseña incorrecta para ${dto.action}`,
      });
      this.throwError('APPROVAL_DENIED', 'Credenciales incorrectas o usuario no autorizado.');
    }

    await this.auditService.record({
      businessId,
      userId: approver.id,
      userRole: approver.role,
      action: 'APPROVAL_ATTEMPT_SUCCESS',
      entityType: 'CashRegister',
      entityId: dto.cashRegisterId,
      reason: `Aprobación concedida para ${dto.action}`,
    });

    const rawToken = randomBytes(32).toString('hex');
    const hashedToken = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.TOKEN_EXPIRATION_MINUTES);

    await this.prisma.posApprovalToken.create({
      data: {
        businessId,
        approvedById: approver.id,
        action: dto.action,
        token: hashedToken,
        entityType: dto.entityType,
        entityId: dto.entityId,
        expiresAt
      }
    });

    return rawToken;
  }

  /**
   * Consume and validates an approval token.
   * Throws BadRequestException if invalid, expired, or already used.
   * Format requested by user:
   * { statusCode: 400, code: 'APPROVAL_INVALID', message: { code: 'APPROVAL_INVALID', message: '...' } }
   */
  async consumeToken(businessId: string, action: string, tokenString?: string): Promise<string> {
    if (!tokenString) {
      this.throwError('APPROVAL_REQUIRED', `La acción ${action} requiere aprobación de un encargado.`);
    }

    const hashedToken = createHash('sha256').update(tokenString).digest('hex');

    const token = await this.prisma.posApprovalToken.findUnique({
      where: { token: hashedToken }
    });

    if (!token) {
      this.throwError('APPROVAL_INVALID', 'Token de aprobación inválido o no encontrado.');
    }

    if (token.businessId !== businessId) {
      this.throwError('APPROVAL_INVALID', 'Token de aprobación no pertenece a este negocio.');
    }

    if (token.action !== action) {
      this.throwError('APPROVAL_INVALID', `El token provisto es para otra acción (${token.action}), no para ${action}.`);
    }

    if (token.isUsed) {
      this.throwError('APPROVAL_INVALID', 'Este token de aprobación ya fue utilizado.');
    }

    if (new Date() > token.expiresAt) {
      this.throwError('APPROVAL_INVALID', 'El token de aprobación ha expirado.');
    }

    // Mark as used
    await this.prisma.posApprovalToken.update({
      where: { id: token.id },
      data: { isUsed: true }
    });

    return token.approvedById;
  }

  private throwError(code: string, message: string): never {
    let statusCode = 400;
    let error = 'Bad Request';

    if (code === 'APPROVAL_REQUIRED' || code === 'APPROVAL_INVALID') {
      statusCode = 403;
      error = 'Forbidden';
    } else if (code === 'APPROVAL_LOCKED') {
      statusCode = 429;
      error = 'Too Many Requests';
    }

    throw new (require('@nestjs/common').HttpException)({
      statusCode,
      error,
      code: code,
      message: {
        code: code,
        message: message
      }
    }, statusCode);
  }
}
