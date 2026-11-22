import { UserRole } from '@prisma/client';

export enum PushCategory {
  STOCK_BAJO = 'STOCK_BAJO',
  POR_VENCER = 'POR_VENCER',
  CAJA_DESCUADRE = 'CAJA_DESCUADRE',
  VENTA_ANULADA = 'VENTA_ANULADA',
  RESUMEN_DIA = 'RESUMEN_DIA',
  CREDITO_POR_VENCER = 'CREDITO_POR_VENCER',
  CREDITO_VENCIDO = 'CREDITO_VENCIDO',
  ABONO_RECIBIDO = 'ABONO_RECIBIDO',
  PAGO_PROVEEDOR_POR_VENCER = 'PAGO_PROVEEDOR_POR_VENCER',
  CUENTA_DISPOSITIVO = 'CUENTA_DISPOSITIVO',
  AVISO_NEXOL = 'AVISO_NEXOL',
}

export const ALL_PUSH_CATEGORIES: PushCategory[] = Object.values(PushCategory);

/**
 * Categorías obligatorias de cuenta que no se pueden apagar.
 */
export const MANDATORY_PUSH_CATEGORIES: ReadonlySet<PushCategory> = new Set([
  PushCategory.CUENTA_DISPOSITIVO,
  PushCategory.AVISO_NEXOL,
]);

/**
 * Categorías apagadas por defecto (el resto vienen encendidas).
 */
export const DEFAULT_DISABLED_CATEGORIES: ReadonlySet<PushCategory> = new Set([
  PushCategory.RESUMEN_DIA,
]);

/**
 * Categorías con prioridad alta en Android (el resto prioridad normal).
 */
export const HIGH_PRIORITY_CATEGORIES: ReadonlySet<PushCategory> = new Set([
  PushCategory.CUENTA_DISPOSITIVO,
  PushCategory.CAJA_DESCUADRE,
]);

/**
 * Roles habilitados para ver y configurar categorías de gestión.
 * El resto de roles solo ven CUENTA_DISPOSITIVO.
 */
export const PUSH_MANAGEMENT_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ENCARGADO,
  UserRole.SUPERADMIN,
]);

/**
 * Códigos de error FCM que indican un token inválido o no registrado
 * y deben desactivar el token automáticamente.
 */
export const INVALID_FCM_TOKEN_ERRORS: ReadonlySet<string> = new Set([
  'UNREGISTERED',
  'INVALID_ARGUMENT',
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export const PUSH_FIREBASE_APP_NAME = 'nexol-pos-push';
export const PUSH_LOG_RETENTION_DAYS = 30;
export const DEFAULT_DEDUPE_WINDOW_MINUTES = 60;
export const FCM_MULTICAST_BATCH_SIZE = 500;
export const PUSH_TEST_COOLDOWN_MS = 60 * 1000;
export const PUSH_BROADCAST_COOLDOWN_MS = 5 * 60 * 1000;
export const PUSH_DEDUPE_LOCK_NAMESPACE = 3000200;
export const PUSH_MORNING_CRON_LOCK_ID = 3000301;
export const PUSH_EVENING_CRON_LOCK_ID = 3000302;
export const PUSH_BATCH_BUSINESSES_SIZE = 50;
