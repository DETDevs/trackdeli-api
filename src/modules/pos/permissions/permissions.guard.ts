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
    request.posPolicies = policies;

    // Regla 113d: Si returnsEnabled=false o voidsCompletedEnabled=false, nadie puede.
    if (action === PosAction.ANULAR_VENTA_COBRADA && policies?.voidsCompletedEnabled === false) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'VOIDS_DISABLED',
        message: { code: 'VOIDS_DISABLED', message: 'La anulación de ventas está deshabilitada en este negocio.' }
      });
    }
    if (action === PosAction.DEVOLUCION && policies?.returnsEnabled === false) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'RETURNS_DISABLED',
        message: { code: 'RETURNS_DISABLED', message: 'Las devoluciones están deshabilitadas en este negocio.' }
      });
    }

    // By default SUPERADMIN bypasses early
    if (user.role === UserRole.SUPERADMIN) return true;

    // Regla 113d: El cajero solicita y el encargado aprueba en esa caja.
    // Para anular y devolver, se permite el acceso al controller para que el servicio
    // valide el token de aprobación o permita directo si no se requiere aprobación.
    if (user.role === UserRole.CAJERO && (action === PosAction.ANULAR_VENTA_COBRADA || action === PosAction.DEVOLUCION || action === PosAction.AJUSTE_INVENTARIO)) {
      return true;
    }

    const allowed = this.permissionsService.can(user.role, action, policies);

    if (!allowed) {
      let friendlyMessage = `El rol ${user.role} no tiene permiso para la acción ${action} o la política del negocio lo prohíbe.`;
      if (action === PosAction.GROUP_MANAGE) {
        friendlyMessage = 'Solo el encargado puede gestionar o eliminar empresas clientes';
      } else if (action === PosAction.GROUP_SETTLE) {
        friendlyMessage = 'Solo el encargado puede anular un estado de cuenta';
      } else if (action === PosAction.CIERRE_TURNO_OTRO) {
        friendlyMessage = 'Solo el encargado puede forzar el cierre de turno de otro usuario';
      }

      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'POLICY_FORBIDDEN',
        message: friendlyMessage,
      });
    }

    return true;
  }
}
