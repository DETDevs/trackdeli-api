import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SKIP_MEMBERSHIP_KEY } from '../decorators/skip-membership.decorator';
import { BusinessType, MembershipStatus, StatementStatus, UserRole } from '@prisma/client';

@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const skipMembership = this.reflector.getAllAndOverride<boolean>(SKIP_MEMBERSHIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipMembership) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Solo para ENCARGADO — verificar estado financiero según tipo de negocio
    if (user && user.role === UserRole.ENCARGADO && user.businessId) {
      const path = request.route?.path || request.url || '';
      // Permitir endpoints de perfil/refresh/commissions/statements para que el encargado pueda revisar sus estados de cuenta
      if (
        path.includes('/auth/me') ||
        path.includes('/auth/refresh') ||
        path.includes('/commissions') ||
        path.includes('/statements')
      ) {
        return true;
      }

      const business = await this.prisma.business.findUnique({
        where: { id: user.businessId },
        select: { businessType: true },
      });

      if (business?.businessType === BusinessType.EMPRESA_RIDERS) {
        const overdueStatement = await this.prisma.monthlyStatement.findFirst({
          where: {
            businessId: user.businessId,
            status: StatementStatus.OVERDUE,
          },
        });

        if (overdueStatement) {
          throw new HttpException(
            {
              statusCode: 402,
              message: `Comisión pendiente de C$${overdueStatement.totalCommission.toFixed(2)}. Contactá a TrackDeli para regularizar.`,
              error: 'Payment Required',
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      } else {
        const now = new Date();
        const activeMembership = await this.prisma.membership.findFirst({
          where: {
            businessId: user.businessId,
            status: MembershipStatus.ACTIVE,
            startDate: { lte: now },
            endDate: { gte: now },
          },
        });

        // Si no tiene membresía activa, bloquear con 402 Payment Required
        if (!activeMembership) {
          throw new HttpException(
            {
              statusCode: 402,
              message: 'Membresía vencida o inactiva. Contactá a TrackDeli para renovar.',
              error: 'Payment Required',
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
      }
    }

    return true;
  }
}
