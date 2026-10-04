import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { randomBytes } from 'crypto';

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);
  private readonly TOKEN_EXPIRATION_MINUTES = 5;

  constructor(private readonly prisma: PrismaService) {}

  async createToken(
    businessId: string,
    approvedById: string,
    action: string,
    entityType?: string,
    entityId?: string
  ): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.TOKEN_EXPIRATION_MINUTES);

    await this.prisma.posApprovalToken.create({
      data: {
        businessId,
        approvedById,
        action,
        token,
        entityType,
        entityId,
        expiresAt
      }
    });

    return token;
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

    const token = await this.prisma.posApprovalToken.findUnique({
      where: { token: tokenString }
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
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: code,
      message: {
        code: code,
        message: message
      }
    });
  }
}
