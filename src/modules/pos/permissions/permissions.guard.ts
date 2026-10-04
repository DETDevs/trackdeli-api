import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PosPermissionsService, PosAction } from './permissions.service';
import { PoliciesService } from '../policies/policies.service';
import { POS_ACTION_KEY } from './require-action.decorator';
import { UserRole } from '@prisma/client';

@Injectable()
export class PosPermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissionsService: PosPermissionsService,
    private policiesService: PoliciesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<PosAction>(POS_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!action) {
      return true; // No action required, pass
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return false;

    // By default SUPERADMIN bypasses early
    if (user.role === UserRole.SUPERADMIN) return true;

    const businessId = request.query.businessId || user.businessId || user.id;
    if (!businessId) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'POLICY_FORBIDDEN',
        message: { code: 'POLICY_FORBIDDEN', message: 'No se pudo identificar el negocio.' }
      });
    }

    const policies = await this.policiesService.get(businessId);
    
    // Almacenamos policies en el request por si el controller las necesita
    request.posPolicies = policies;

    const allowed = this.permissionsService.can(user.role, action, policies);

    if (!allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'POLICY_FORBIDDEN',
        message: {
          code: 'POLICY_FORBIDDEN',
          message: `El rol ${user.role} no tiene permiso para la acción ${action} o la política del negocio lo prohíbe.`
        }
      });
    }

    return true;
  }
}
