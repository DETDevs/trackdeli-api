import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      return !requiredRoles;
    }

    if (user.role === UserRole.SUPERADMIN) {
      return true;
    }

    // Role WAITER has strictly limited access: ONLY endpoints explicitly marked with WAITER are accessible
    if (user.role === UserRole.WAITER) {
      return !!requiredRoles && requiredRoles.includes(UserRole.WAITER);
    }

    if (!requiredRoles) {
      return true;
    }

    return requiredRoles.includes(user.role);
  }
}
