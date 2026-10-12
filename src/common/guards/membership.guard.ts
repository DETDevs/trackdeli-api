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
import {
  calculateDueDate,
  calculateGraceEndsAt,
  getManaguaDateParts,
} from '../../modules/superadmin/utils/membership-billing.util';

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

    if (user && user.role === UserRole.ENCARGADO && user.businessId) {
      const path = request.route?.path || request.url || '';

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
        const memberships = await this.prisma.membership.findMany({
          where: {
            businessId: user.businessId,
            status: { in: [MembershipStatus.ACTIVE, MembershipStatus.EXPIRED] },
            startDate: { lte: now },
          },
          include: {
            business: {
              select: {
                id: true,
                createdAt: true,
                billingAnchorDay: true,
              },
            },
          },
          orderBy: { endDate: 'desc' },
        });

        let isAuthorized = false;
        for (const m of memberships) {
          if (m.status === MembershipStatus.CANCELLED) continue;
          const anchor =
            m.business.billingAnchorDay ?? getManaguaDateParts(m.startDate).day;
          const dueDate = calculateDueDate(m.startDate, anchor);
          const graceEndsAt = calculateGraceEndsAt(dueDate);

          if (now < graceEndsAt) {
            isAuthorized = true;
            break;
          }
        }

        if (!isAuthorized) {
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

