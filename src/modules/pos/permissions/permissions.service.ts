import { Injectable, Logger } from '@nestjs/common';
import { UserRole, PosPolicies } from '@prisma/client';

export enum PosAction {
  VENDER_COBRAR = 'VENDER_COBRAR',
  APLICAR_DESCUENTO = 'APLICAR_DESCUENTO',
  CAMBIAR_PRECIO = 'CAMBIAR_PRECIO',
  ANULAR_CARRITO = 'ANULAR_CARRITO',
  ANULAR_VENTA_COBRADA = 'ANULAR_VENTA_COBRADA',
  DEVOLUCION = 'DEVOLUCION',
  MOVIMIENTO_CAJA = 'MOVIMIENTO_CAJA',
  ABRIR_CAJON_SIN_VENTA = 'ABRIR_CAJON_SIN_VENTA',
  CIERRE_TURNO_PROPIO = 'CIERRE_TURNO_PROPIO',
  CIERRE_TURNO_OTRO = 'CIERRE_TURNO_OTRO',
  COMPRA_PROVEEDOR = 'COMPRA_PROVEEDOR',
  AJUSTE_INVENTARIO = 'AJUSTE_INVENTARIO',
  VER_AUDITORIA = 'VER_AUDITORIA',
  CAMBIAR_POLITICAS = 'CAMBIAR_POLITICAS',
  CAMBIAR_TASA_DOLAR = 'CAMBIAR_TASA_DOLAR',
  ABONAR_CREDITO = 'ABONAR_CREDITO',
  GROUP_MANAGE = 'GROUP_MANAGE',
  GROUP_STATEMENT = 'GROUP_STATEMENT',
  GROUP_SETTLE = 'GROUP_SETTLE',
  CREDIT_LIMIT_OVERRIDE = 'CREDIT_LIMIT_OVERRIDE',
}

@Injectable()
export class PosPermissionsService {
  private readonly logger = new Logger(PosPermissionsService.name);

  can(role: UserRole, action: PosAction, policies: PosPolicies | null): boolean {
    if (role === UserRole.SUPERADMIN || role === UserRole.ENCARGADO) {
      return true; // Tienen acceso a todo
    }

    if (role === UserRole.CAJERO) {
      switch (action) {
        case PosAction.VENDER_COBRAR:
          return true;
        case PosAction.ABONAR_CREDITO:
          return true;
        case PosAction.APLICAR_DESCUENTO:
          return policies?.discountsEnabled ?? true;
        case PosAction.CAMBIAR_PRECIO:
          return false; // Requiere aprobación
        case PosAction.ANULAR_CARRITO:
          return true;
        case PosAction.ANULAR_VENTA_COBRADA:
          // Comportamiento de regresión: si las políticas dicen que no requiere aprobación, el cajero puede anular.
          // Antes podía hacerlo sin restricción. Ahora usa el interruptor.
          return !(policies?.voidsRequireApproval ?? true);
        case PosAction.DEVOLUCION:
          return !(policies?.returnsRequireApproval ?? true);
        case PosAction.MOVIMIENTO_CAJA:
          return true;
        case PosAction.ABRIR_CAJON_SIN_VENTA:
          return policies?.noSaleDrawerOpenAllowed ?? true;
        case PosAction.CIERRE_TURNO_PROPIO:
          return true;
        case PosAction.CIERRE_TURNO_OTRO:
          return false;
        case PosAction.COMPRA_PROVEEDOR:
          return false;
        case PosAction.AJUSTE_INVENTARIO:
          return !(policies?.inventoryAdjustRequireApproval ?? true);
        case PosAction.VER_AUDITORIA:
          return false;
        case PosAction.CAMBIAR_POLITICAS:
          return false;
        case PosAction.CAMBIAR_TASA_DOLAR:
          return false;
        case PosAction.GROUP_MANAGE:
        case PosAction.GROUP_STATEMENT:
        case PosAction.GROUP_SETTLE:
        case PosAction.CREDIT_LIMIT_OVERRIDE:
          return false;
        default:
          return false;
      }
    }

    if (role === UserRole.WAITER) {
      // WAITER solo puede tomar pedido, pero eso está modelado en TableOrders (fuera de control de dinero estricto por ahora)
      return false;
    }

    return false;
  }
}
