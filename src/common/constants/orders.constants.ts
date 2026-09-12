import { OrderStatus } from '@prisma/client';

export const MAX_ACTIVE_ORDERS_PER_RIDER = 2;

export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.ACEPTADO,
  OrderStatus.EN_CAMINO_AL_NEGOCIO,
  OrderStatus.EN_EL_NEGOCIO,
  OrderStatus.EN_CAMINO,
  OrderStatus.CERCA_DEL_DESTINO,
  OrderStatus.VERIFICANDO_ENTREGA,
];

export const MAX_ACTIVE_ORDERS_ERROR_MESSAGE = 'Ya tenés el máximo de pedidos activos permitidos';

