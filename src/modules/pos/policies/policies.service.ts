import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PosPolicies } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PosAction } from '../permissions/permissions.service';

@Injectable()
export class PoliciesService {
  private readonly logger = new Logger(PoliciesService.name);
  
  // Cache simple en memoria: businessId -> { data: PosPolicies, expiresAt: number }
  // NOTA: Hay una sola réplica hoy, así que esto funciona bien. 
  // Con varias réplicas (escalabilidad horizontal) habría que invalidar por Redis o reducir el TTL.
  private cache = new Map<string, { data: PosPolicies, expiresAt: number }>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutos

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService
  ) {}

  async get(businessId: string): Promise<PosPolicies> {
    const cached = this.cache.get(businessId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    let policies = await this.prisma.posPolicies.findUnique({
      where: { businessId }
    });

    if (!policies) {
      // Fallback por si acaso falló el backfill
      policies = await this.prisma.posPolicies.create({
        data: { businessId }
      });
    }

    this.cache.set(businessId, { data: policies, expiresAt: Date.now() + this.TTL_MS });
    return policies;
  }

  async update(businessId: string, updates: Partial<PosPolicies>, userId: string, userRole: string): Promise<PosPolicies> {
    const current = await this.get(businessId);
    
    // Remover businessId de updates para evitar intentos de reescritura de PK
    delete (updates as any).businessId;

    if (Object.keys(updates).length === 0) return current;

    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.posPolicies.update({
        where: { businessId },
        data: updates
      });

      await this.auditService.record({
        businessId,
        userId,
        userRole,
        action: PosAction.CAMBIAR_POLITICAS,
        entityType: 'PosPolicies',
        entityId: businessId,
        before: current,
        after: res,
        reason: 'Actualización de políticas del POS'
      }, tx);

      return res;
    });

    // Invalida cache
    this.cache.set(businessId, { data: updated, expiresAt: Date.now() + this.TTL_MS });
    return updated;
  }
}
