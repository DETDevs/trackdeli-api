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
import { MembershipStatus, UserRole } from '@prisma/client';

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

    // Solo para ENCARGADO — verificar membresía activa
    if (user && user.role === UserRole.ENCARGADO && user.businessId) {
      const path = request.route?.path || request.url || '';
      // Permitir endpoints de perfil/refresh para que el frontend pueda cargar datos básicos del usuario
      if (path.includes('/auth/me') || path.includes('/auth/refresh')) {
        return true;
      }

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

    return true;
  }
}
