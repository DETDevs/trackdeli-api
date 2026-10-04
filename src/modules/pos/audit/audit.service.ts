import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface AuditRecordParams {
  businessId: string;
  userId: string;
  userRole: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: any;
  after?: any;
  reason?: string;
  terminalId?: string;
  ipAddress?: string;
  approvedById?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra una acción en el log de auditoría de forma inmutable.
   * Si se provee `tx` (Prisma.TransactionClient), se adjunta a esa transacción.
   */
  record(data: AuditRecordParams, tx?: Prisma.TransactionClient | PrismaService) {
    const db = tx || this.prisma;
    
    // No guardamos secretos
    const safeBefore = this.sanitizeSecrets(data.before);
    const safeAfter = this.sanitizeSecrets(data.after);

    return db.posAuditLog.create({
      data: {
        businessId: data.businessId,
        userId: data.userId,
        userRole: data.userRole,
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        before: safeBefore ?? Prisma.DbNull,
        after: safeAfter ?? Prisma.DbNull,
        reason: data.reason,
        terminalId: data.terminalId,
        ipAddress: data.ipAddress,
        approvedById: data.approvedById,
      }
    });
  }

  private sanitizeSecrets(obj: any): any {
    if (!obj) return obj;
    let jsonSafeObj = obj;
    try {
      jsonSafeObj = JSON.parse(JSON.stringify(obj));
    } catch {
      jsonSafeObj = obj;
    }
    if (typeof jsonSafeObj !== 'object' || jsonSafeObj === null) return jsonSafeObj;
    
    const clone = Array.isArray(jsonSafeObj) ? [...jsonSafeObj] : { ...jsonSafeObj };
    const secretKeys = ['password', 'passwordHash', 'token', 'pin', 'managerPassword', 'accessToken', 'refreshToken'];
    
    for (const key of Object.keys(clone)) {
      if (secretKeys.includes(key) || key.toLowerCase().includes('password') || key.toLowerCase().includes('token')) {
        clone[key] = '***';
      } else if (typeof clone[key] === 'object' && clone[key] !== null) {
        clone[key] = this.sanitizeSecrets(clone[key]);
      }
    }
    return clone;
  }
}
