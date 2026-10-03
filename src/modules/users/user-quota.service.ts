import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';

export const BASE_USER_LIMIT = 6;

@Injectable()
export class UserQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async getUsage(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { extraUserSlots: true },
    });

    if (!business) {
      throw new Error('Business not found for quota check');
    }

    const used = await this.prisma.user.count({
      where: {
        businessId,
        isActive: true,
        role: { in: [UserRole.ENCARGADO, UserRole.CAJERO, UserRole.WAITER] },
      },
    });

    const base = BASE_USER_LIMIT;
    const extra = business.extraUserSlots;
    const limit = base + extra;
    const remaining = Math.max(0, limit - used);

    return { used, base, extra, limit, remaining };
  }

  async checkQuota(businessId: string): Promise<void> {
    const usage = await this.getUsage(businessId);
    if (usage.remaining <= 0) {
      throw new ConflictException({
        code: 'USER_LIMIT_REACHED',
        message: `Se ha alcanzado el límite de usuarios activos para este negocio (${usage.limit}). Desactive un usuario existente o solicite al superadmin una ampliación de cupos.`,
        usage
      });
    }
  }
}
