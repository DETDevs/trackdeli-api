import { OrderStatus } from '@prisma/client';

/**
 * Cantidad máxima de pedidos activos simultáneos permitidos por repartidor.
 * Ajustable fácilmente para futuras iteraciones o reglas dinámicas.
 */
export const MAX_ACTIVE_ORDERS_PER_RIDER = 2;

/**
 * Estados que definen un pedido como "activo" en curso para un repartidor.
 * Abarca desde la asignación inicial (ACEPTADO) hasta el proceso de verificación final (VERIFICANDO_ENTREGA).
 * Excluye pedidos no asignados (PENDIENTE, COTIZANDO, OFERTADO) y terminales (ENTREGADO, CANCELADO, CERRADO).
 */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.ACEPTADO,
  OrderStatus.EN_CAMINO_AL_NEGOCIO,
  OrderStatus.EN_EL_NEGOCIO,
  OrderStatus.EN_CAMINO,
  OrderStatus.CERCA_DEL_DESTINO,
  OrderStatus.VERIFICANDO_ENTREGA,
];

/**
 * Mensaje estándar arrojado en excepciones HTTP 409 (Conflict) al exceder el límite de pedidos activos.
 */
export const MAX_ACTIVE_ORDERS_ERROR_MESSAGE = 'Ya tenés el máximo de pedidos activos permitidos';
