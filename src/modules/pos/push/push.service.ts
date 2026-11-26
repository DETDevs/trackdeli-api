import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BusinessProductStatus,
  BusinessProductType,
  UserRole,
} from '@prisma/client';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { getManaguaDateParts } from '../../superadmin/utils/membership-billing.util';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  formatDateInTimezone,
} from '../../../common/utils/date.util';
import {
  ALL_PUSH_CATEGORIES,
  DEFAULT_DEDUPE_WINDOW_MINUTES,
  DEFAULT_DISABLED_CATEGORIES,
  FCM_MULTICAST_BATCH_SIZE,
  HIGH_PRIORITY_CATEGORIES,
  INVALID_FCM_TOKEN_ERRORS,
  MANDATORY_PUSH_CATEGORIES,
  PUSH_BATCH_BUSINESSES_SIZE,
  PUSH_BROADCAST_COOLDOWN_MS,
  PUSH_DEDUPE_LOCK_NAMESPACE,
  PUSH_FIREBASE_APP_NAME,
  PUSH_INBOX_DEFAULT_TAKE,
  PUSH_INBOX_MAX_TAKE,
  PUSH_INBOX_RETENTION_DAYS,
  PUSH_LOG_RETENTION_DAYS,
  PUSH_MANAGEMENT_ROLES,
  PUSH_TEST_COOLDOWN_MS,
  PushCategory,
} from './push.constants';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { UpdatePushPreferencesDto } from './dto/update-push-preferences.dto';

export interface FcmMulticastMessage {
  tokens: string[];
  notification: {
    title: string;
    body: string;
  };
  data: Record<string, string>;
  android: {
    priority: 'normal' | 'high';
    notification: {
      channelId: string;
      sound: string;
    };
  };
}

export interface FcmBatchResponseItem {
  success: boolean;
  messageId?: string;
  error?: {
    code?: string;
    message?: string;
  };
}

export interface FcmBatchResponse {
  successCount: number;
  failureCount: number;
  responses: FcmBatchResponseItem[];
}

export interface FcmMessagingClient {
  sendEachForMulticast(message: FcmMulticastMessage): Promise<FcmBatchResponse>;
}

export interface SendPushInput {
  businessId: string;
  roles?: UserRole[];
  userIds?: string[];
  excludeUserIds?: string[];
  deviceId?: string;
  allowRevokedDevice?: boolean;
  category: PushCategory;
  title: string;
  body: string;
  data?: {
    category?: string;
    screen?: string;
    id?: string;
  };
  dedupeKey?: string;
  dedupeWindowMinutes?: number;
  /** Si es true (ej. /pos/push/test), no se guarda en el historial de avisos. */
  skipInbox?: boolean;
}

export interface SendPushResult {
  sent: number;
  failed: number;
  skipped: number | string;
  error?: string;
}

interface ActiveTokenRow {
  id: string;
  businessId: string;
  userId: string;
  deviceId: string;
  token: string;
  platform: string;
}

interface PreferenceRow {
  userId: string;
  category: string;
  enabled: boolean;
  quietStart: string | null;
  quietEnd: string | null;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private firebaseApp: admin.app.App | null = null;
  private messagingClient: FcmMessagingClient | null = null;
  private enabled = false;

  /** Rate limit en memoria para POST /pos/push/test (1 por minuto por dispositivo). */
  private readonly testCooldownMap = new Map<string, number>();

  /** Rate limit en memoria para POST /superadmin/push/broadcast (1 cada 5 min). */
  private lastBroadcastAtMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit(): void {
    this.initializeFirebase();
  }

  /**
   * Inicializa Firebase Admin SDK con FIREBASE_SERVICE_ACCOUNT_JSON o, como respaldo,
   * con FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
   * Nunca imprime ni expone credenciales en logs ni errores.
   * Si faltan o son inválidas, el servicio queda apagado y el API arranca normal.
   */
  private initializeFirebase(): void {
    const rawJson = (
      this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON') ||
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      ''
    ).trim();

    let serviceAccount: {
      projectId: string;
      clientEmail: string;
      privateKey: string;
    } | null = null;
    let sourceLabel = '';

    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.project_id === 'string' &&
          typeof parsed.client_email === 'string' &&
          typeof parsed.private_key === 'string' &&
          parsed.project_id.trim() &&
          parsed.client_email.trim() &&
          parsed.private_key.trim()
        ) {
          serviceAccount = {
            projectId: parsed.project_id.trim(),
            clientEmail: parsed.client_email.trim(),
            privateKey: parsed.private_key.replace(/\\n/g, '\n'),
          };
          sourceLabel = 'FIREBASE_SERVICE_ACCOUNT_JSON';
        } else {
          this.logger.warn(
            '[PushService] FIREBASE_SERVICE_ACCOUNT_JSON incompleto o con formato inválido; verificando variables individuales FIREBASE_*.',
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `[PushService] No se pudo parsear FIREBASE_SERVICE_ACCOUNT_JSON (${err?.name || 'Error'}); verificando variables individuales FIREBASE_*.`,
        );
      }
    }

    if (!serviceAccount) {
      const projectId = (
        this.config.get<string>('FIREBASE_PROJECT_ID') ||
        process.env.FIREBASE_PROJECT_ID ||
        ''
      ).trim();
      const clientEmail = (
        this.config.get<string>('FIREBASE_CLIENT_EMAIL') ||
        process.env.FIREBASE_CLIENT_EMAIL ||
        ''
      ).trim();
      let privateKey = (
        this.config.get<string>('FIREBASE_PRIVATE_KEY') ||
        process.env.FIREBASE_PRIVATE_KEY ||
        ''
      ).trim();

      if (
        (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
        (privateKey.startsWith("'") && privateKey.endsWith("'"))
      ) {
        privateKey = privateKey.slice(1, -1);
      }
      privateKey = privateKey.replace(/\\n/g, '\n');

      if (projectId && clientEmail && privateKey) {
        serviceAccount = { projectId, clientEmail, privateKey };
        sourceLabel = 'FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY';
      }
    }

    if (!serviceAccount) {
      this.enabled = false;
      this.messagingClient = null;
      this.logger.warn(
        '[PushService] Notificaciones push desactivadas: faltan FIREBASE_SERVICE_ACCOUNT_JSON o FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.',
      );
      return;
    }

    try {
      const existing = admin.apps.find((a) => a?.name === PUSH_FIREBASE_APP_NAME);
      if (existing) {
        this.firebaseApp = existing;
      } else {
        this.firebaseApp = admin.initializeApp(
          {
            credential: admin.credential.cert(serviceAccount),
          },
          PUSH_FIREBASE_APP_NAME,
        );
      }

      this.messagingClient = this.firebaseApp.messaging() as unknown as FcmMessagingClient;
      this.enabled = true;
      this.logger.log(
        `[PushService] Servicio de notificaciones push inicializado correctamente (FCM HTTP v1, project=${serviceAccount.projectId}, source=${sourceLabel}).`,
      );
    } catch (err: any) {
      this.enabled = false;
      this.messagingClient = null;
      this.logger.warn(
        `[PushService] Notificaciones push desactivadas: error inicializando Firebase Admin (${err?.code || err?.name || 'INIT_ERROR'}).`,
      );
    }
  }

  isEnabled(): boolean {
    return this.enabled && this.messagingClient !== null;
  }

  /**
   * Permite inyectar un cliente FCM simulado en pruebas locales sin llamar a Firebase real.
   */
  setMessagingClientForTesting(client: FcmMessagingClient | null): void {
    this.messagingClient = client;
    this.enabled = client !== null;
  }

  // ═══════════════════════════════════════════════════════════════
  // TOKENS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Registra o actualiza el token FCM del dispositivo móvil actual.
   * Si el token ya existía en otro dispositivo, se mueve; si el dispositivo
   * ya tenía otro token, se reemplaza. Operación atómica e idempotente.
   */
  async registerToken(
    businessId: string,
    userId: string,
    deviceId: string,
    dto: RegisterPushTokenDto,
    headerPlatform?: string,
  ) {
    const cleanToken = dto.token.trim();
    const cleanDeviceId = deviceId.trim();
    const cleanAppVersion = dto.appVersion ? dto.appVersion.trim() : null;
    const resolvedPlatform =
      dto.platform ||
      (headerPlatform && headerPlatform.toLowerCase().includes('ios') ? 'ios' : 'android');

    const now = new Date();
    const newId = crypto.randomUUID();

    await this.prisma.$transaction(async (tx) => {
      // Si el token ya existía en otro dispositivo, moverlo eliminando el registro viejo
      await tx.$executeRaw`
        DELETE FROM "pos_push_tokens"
        WHERE "token" = ${cleanToken}
          AND "deviceId" <> ${cleanDeviceId}
      `;

      // Upsert atómico por deviceId (reemplaza el token previo del mismo dispositivo)
      await tx.$executeRaw`
        INSERT INTO "pos_push_tokens" (
          "id", "businessId", "userId", "deviceId", "token",
          "platform", "appVersion", "isActive",
          "createdAt", "updatedAt", "lastSeenAt", "lastErrorAt", "lastErrorCode"
        ) VALUES (
          ${newId}, ${businessId}, ${userId}, ${cleanDeviceId}, ${cleanToken},
          ${resolvedPlatform}, ${cleanAppVersion}, true,
          ${now}, ${now}, ${now}, NULL, NULL
        )
        ON CONFLICT ("deviceId") DO UPDATE SET
          "businessId" = EXCLUDED."businessId",
          "userId" = EXCLUDED."userId",
          "token" = EXCLUDED."token",
          "platform" = EXCLUDED."platform",
          "appVersion" = EXCLUDED."appVersion",
          "isActive" = true,
          "updatedAt" = ${now},
          "lastSeenAt" = ${now},
          "lastErrorAt" = NULL,
          "lastErrorCode" = NULL
      `;
    });

    return {
      success: true,
      deviceId: cleanDeviceId,
      platform: resolvedPlatform,
      appVersion: cleanAppVersion,
      isActive: true,
      updatedAt: now.toISOString(),
    };
  }

  /**
   * Desactiva el token push del dispositivo actual (cierre de sesión).
   */
  async deactivateToken(deviceId: string) {
    const cleanDeviceId = deviceId.trim();
    const updatedCount = await this.prisma.$executeRaw`
      UPDATE "pos_push_tokens"
      SET "isActive" = false, "updatedAt" = NOW()
      WHERE "deviceId" = ${cleanDeviceId} AND "isActive" = true
    `;

    return {
      success: true,
      deviceId: cleanDeviceId,
      deactivated: Number(updatedCount) > 0,
    };
  }

  /**
   * Desactiva todos los tokens activos de un dispositivo al revocarlo.
   * Nunca lanza excepción para no interrumpir la revocación.
   */
  async deactivateTokensByDevice(businessId: string, deviceId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "pos_push_tokens"
        SET "isActive" = false, "updatedAt" = NOW()
        WHERE "businessId" = ${businessId}
          AND "deviceId" = ${deviceId}
          AND "isActive" = true
      `;
    } catch (err: any) {
      this.logger.warn(
        `[PushService] Error al desactivar tokens de dispositivo ${deviceId}: ${err?.message || 'desconocido'}`,
      );
    }
  }

  /**
   * Desactiva todos los tokens activos de un usuario al desactivarlo.
   * Nunca lanza excepción para no interrumpir la desactivación del usuario.
   */
  async deactivateTokensByUser(userId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "pos_push_tokens"
        SET "isActive" = false, "updatedAt" = NOW()
        WHERE "userId" = ${userId}
          AND "isActive" = true
      `;
    } catch (err: any) {
      this.logger.warn(
        `[PushService] Error al desactivar tokens de usuario ${userId}: ${err?.message || 'desconocido'}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PREFERENCIAS
  // ═══════════════════════════════════════════════════════════════

  private getAllowedCategoriesForRole(role: UserRole): PushCategory[] {
    if (PUSH_MANAGEMENT_ROLES.has(role)) {
      return [...ALL_PUSH_CATEGORIES];
    }
    return [PushCategory.CUENTA_DISPOSITIVO];
  }

  private getDefaultEnabled(category: PushCategory): boolean {
    if (MANDATORY_PUSH_CATEGORIES.has(category)) {
      return true;
    }
    return !DEFAULT_DISABLED_CATEGORIES.has(category);
  }

  async getPreferences(userId: string, role: UserRole) {
    const allowedCategories = this.getAllowedCategoriesForRole(role);

    const rows = await this.prisma.$queryRaw<PreferenceRow[]>`
      SELECT "userId", "category", "enabled", "quietStart", "quietEnd"
      FROM "pos_push_preferences"
      WHERE "userId" = ${userId}
    `;

    const rowMap = new Map<string, PreferenceRow>();
    for (const r of rows) {
      rowMap.set(r.category, r);
    }

    let firstQuietStart: string | null = null;
    let firstQuietEnd: string | null = null;

    const preferences = allowedCategories.map((category) => {
      const saved = rowMap.get(category);
      const isMandatory = MANDATORY_PUSH_CATEGORIES.has(category);
      const enabled = isMandatory
        ? true
        : saved
          ? Boolean(saved.enabled)
          : this.getDefaultEnabled(category);

      const quietStart = saved?.quietStart || null;
      const quietEnd = saved?.quietEnd || null;

      if (!firstQuietStart && quietStart && quietEnd) {
        firstQuietStart = quietStart;
        firstQuietEnd = quietEnd;
      }

      return {
        category,
        enabled,
        canDisable: !isMandatory,
        quietStart,
        quietEnd,
      };
    });

    return {
      quietStart: firstQuietStart,
      quietEnd: firstQuietEnd,
      preferences,
    };
  }

  async updatePreferences(
    userId: string,
    role: UserRole,
    dto: UpdatePushPreferencesDto,
  ) {
    const allowedSet = new Set(this.getAllowedCategoriesForRole(role));

    const hasGlobalQuietStart = dto.quietStart !== undefined;
    const hasGlobalQuietEnd = dto.quietEnd !== undefined;
    const normalizedGlobalStart =
      dto.quietStart === '' ? null : (dto.quietStart ?? undefined);
    const normalizedGlobalEnd =
      dto.quietEnd === '' ? null : (dto.quietEnd ?? undefined);

    if (
      (hasGlobalQuietStart && !hasGlobalQuietEnd) ||
      (!hasGlobalQuietStart && hasGlobalQuietEnd) ||
      (normalizedGlobalStart && !normalizedGlobalEnd) ||
      (!normalizedGlobalStart && normalizedGlobalEnd)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_QUIET_HOURS',
        message:
          'Debés indicar tanto la hora de inicio como la hora de fin del horario silencioso.',
      });
    }

    const items = dto.preferences || [];

    for (const item of items) {
      if (!allowedSet.has(item.category)) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'CATEGORY_FORBIDDEN_FOR_ROLE',
          message:
            'No tenés permiso para configurar esta categoría de notificaciones.',
        });
      }

      if (MANDATORY_PUSH_CATEGORIES.has(item.category) && item.enabled === false) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'CATEGORY_CANNOT_BE_DISABLED',
          message:
            'Esta categoría de notificaciones es obligatoria y no se puede desactivar.',
        });
      }

      const itemStart = item.quietStart === '' ? null : item.quietStart;
      const itemEnd = item.quietEnd === '' ? null : item.quietEnd;
      if (
        (itemStart !== undefined && itemEnd === undefined) ||
        (itemStart === undefined && itemEnd !== undefined) ||
        (itemStart && !itemEnd) ||
        (!itemStart && itemEnd)
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_QUIET_HOURS',
          message:
            'Debés indicar tanto la hora de inicio como la hora de fin del horario silencioso.',
        });
      }
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Si enviaron quietStart/quietEnd globales sin lista de preferencias, aplicar a todas las categorías permitidas
      if (items.length === 0 && (hasGlobalQuietStart || hasGlobalQuietEnd)) {
        for (const category of allowedSet) {
          const defaultEnabled = this.getDefaultEnabled(category);
          const id = crypto.randomUUID();
          await tx.$executeRaw`
            INSERT INTO "pos_push_preferences" (
              "id", "userId", "category", "enabled", "quietStart", "quietEnd", "createdAt", "updatedAt"
            ) VALUES (
              ${id}, ${userId}, ${category}, ${defaultEnabled},
              ${normalizedGlobalStart ?? null}, ${normalizedGlobalEnd ?? null}, ${now}, ${now}
            )
            ON CONFLICT ("userId", "category") DO UPDATE SET
              "quietStart" = EXCLUDED."quietStart",
              "quietEnd" = EXCLUDED."quietEnd",
              "updatedAt" = ${now}
          `;
        }
        return;
      }

      for (const item of items) {
        const finalEnabled = MANDATORY_PUSH_CATEGORIES.has(item.category)
          ? true
          : item.enabled;

        const qStart =
          item.quietStart !== undefined
            ? item.quietStart === ''
              ? null
              : item.quietStart
            : normalizedGlobalStart;
        const qEnd =
          item.quietEnd !== undefined
            ? item.quietEnd === ''
              ? null
              : item.quietEnd
            : normalizedGlobalEnd;

        const id = crypto.randomUUID();
        if (qStart !== undefined || qEnd !== undefined) {
          await tx.$executeRaw`
            INSERT INTO "pos_push_preferences" (
              "id", "userId", "category", "enabled", "quietStart", "quietEnd", "createdAt", "updatedAt"
            ) VALUES (
              ${id}, ${userId}, ${item.category}, ${finalEnabled},
              ${qStart ?? null}, ${qEnd ?? null}, ${now}, ${now}
            )
            ON CONFLICT ("userId", "category") DO UPDATE SET
              "enabled" = EXCLUDED."enabled",
              "quietStart" = EXCLUDED."quietStart",
              "quietEnd" = EXCLUDED."quietEnd",
              "updatedAt" = ${now}
          `;
        } else {
          await tx.$executeRaw`
            INSERT INTO "pos_push_preferences" (
              "id", "userId", "category", "enabled", "quietStart", "quietEnd", "createdAt", "updatedAt"
            ) VALUES (
              ${id}, ${userId}, ${item.category}, ${finalEnabled}, NULL, NULL, ${now}, ${now}
            )
            ON CONFLICT ("userId", "category") DO UPDATE SET
              "enabled" = EXCLUDED."enabled",
              "updatedAt" = ${now}
          `;
        }
      }
    });

    return this.getPreferences(userId, role);
  }

  // ═══════════════════════════════════════════════════════════════
  // NOTIFICACIÓN DE PRUEBA (POST /pos/push/test)
  // ═══════════════════════════════════════════════════════════════

  async sendTestPush(businessId: string, userId: string, deviceId: string) {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'PUSH_NOT_CONFIGURED',
        message:
          'El servicio de notificaciones push no está configurado en este servidor.',
      });
    }

    // Límite estricto: 1 envío de prueba por minuto por dispositivo (en memoria + BD)
    const nowMs = Date.now();
    const lastMem = this.testCooldownMap.get(deviceId) || 0;
    if (nowMs - lastMem < PUSH_TEST_COOLDOWN_MS) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'PUSH_TEST_RATE_LIMITED',
          message:
            'Solo podés enviar una notificación de prueba por minuto. Esperá un momento e intentá de nuevo.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const recentRows = await this.prisma.$queryRaw<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM "pos_push_log"
      WHERE "businessId" = ${businessId}
        AND "deviceId" = ${deviceId}
        AND "dedupeKey" LIKE 'test:%'
        AND "createdAt" >= NOW() - INTERVAL '60 seconds'
    `;
    if ((recentRows[0]?.cnt || 0) > 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'PUSH_TEST_RATE_LIMITED',
          message:
            'Solo podés enviar una notificación de prueba por minuto. Esperá un momento e intentá de nuevo.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.testCooldownMap.set(deviceId, nowMs);

    const result = await this.send({
      businessId,
      deviceId,
      category: PushCategory.CUENTA_DISPOSITIVO,
      title: 'Notificación de prueba',
      body: 'Las notificaciones push de NEXOL POS están funcionando correctamente.',
      data: {
        category: PushCategory.CUENTA_DISPOSITIVO,
        screen: 'settings_notifications',
        id: 'test',
      },
      dedupeKey: `test:${deviceId}:${Math.floor(nowMs / 1000)}`,
      dedupeWindowMinutes: 1,
      skipInbox: true,
    });

    return {
      success: result.sent > 0,
      deviceId,
      userId,
      ...result,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ENVÍO GENERAL (PushService.send)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Dispara un envío push sin bloquear la respuesta HTTP y sin lanzar ni rechazar promesas.
   */
  sendFireAndForget(input: SendPushInput): Promise<void> {
    try {
      if (!this.isEnabled() && input.skipInbox) {
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(async () => {
          try {
            await this.send(input);
          } catch (err: any) {
            try {
              this.logger.warn(
                `[PushService.sendFireAndForget] Error silencioso (category=${input?.category}): ${err?.message || 'desconocido'}`,
              );
            } catch {}
          }
        })
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * 300b (#1 STOCK_BAJO): agrupa productos que acaban de cruzar minStock en la misma operación
   * en un solo aviso, con dedupe diario (hora Managua) por producto. Fire-and-forget.
   * Toda la lógica asíncrona corre dentro de try/catch interno: la promesa nunca se rechaza.
   */
  notifyLowStockCrossed(businessId: string, productIds: string[]): Promise<void> {
    try {
      if (!businessId || !productIds || productIds.length === 0) {
        return Promise.resolve();
      }
      const uniqueIds = Array.from(new Set(productIds.filter(Boolean)));
      if (uniqueIds.length === 0) return Promise.resolve();

      return Promise.resolve()
        .then(async () => {
          try {
            const todayManagua = formatDateInTimezone(new Date(), DEFAULT_BUSINESS_TIMEZONE);
            const candidateKeys = uniqueIds.map((pid) => `stock_bajo:${todayManagua}:${pid}`);

            const alreadySentRows = await this.prisma.$queryRaw<{ dedupeKey: string }[]>`
              SELECT DISTINCT "dedupeKey"
              FROM "pos_push_log"
              WHERE "businessId" = ${businessId}
                AND "status" = 'SENT'
                AND "dedupeKey" = ANY(${candidateKeys}::text[])
                AND "createdAt" >= NOW() - INTERVAL '24 hours'
            `;
            const sentSet = new Set(alreadySentRows.map((r) => r.dedupeKey));
            const freshIds = uniqueIds.filter(
              (pid) => !sentSet.has(`stock_bajo:${todayManagua}:${pid}`),
            );

            if (freshIds.length === 0) return;

            const count = freshIds.length;
            const body =
              count === 1
                ? '1 producto quedó con stock bajo. Revisá tu inventario.'
                : `${count} productos con stock bajo. Revisá tu inventario.`;

            const primaryDedupeKey = `stock_bajo:${todayManagua}:${freshIds[0]}`;
            const res = await this.send({
              businessId,
              roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
              category: PushCategory.STOCK_BAJO,
              title: 'Stock bajo',
              body,
              data: {
                category: PushCategory.STOCK_BAJO,
                screen: 'inventory_alerts',
                id: freshIds[0],
              },
              dedupeKey: primaryDedupeKey,
              dedupeWindowMinutes: 1440,
            });

            // Si hubo más de 1 producto en el lote y se envió, registrar clave dedupe por cada producto restante
            if (res.sent > 0 && freshIds.length > 1) {
              for (const pid of freshIds.slice(1)) {
                await this.writePushLog({
                  businessId,
                  userId: null,
                  deviceId: null,
                  category: PushCategory.STOCK_BAJO,
                  dedupeKey: `stock_bajo:${todayManagua}:${pid}`,
                  status: 'SENT',
                  errorCode: null,
                }).catch(() => {});
              }
            }
          } catch (err: any) {
            try {
              this.logger.warn(
                `[PushService.notifyLowStockCrossed] Error silencioso: ${err?.message || 'desconocido'}`,
              );
            } catch {}
          }
        })
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * 300b (#12 AVISO_NEXOL): broadcast solo para SUPERADMIN.
   * Incluye límite de frecuencia (1 cada 5 minutos), recorrido en lotes de 50 negocios
   * con tolerancia a fallos y registro de auditoría de quién lo envió (sin PII).
   */
  async broadcast(params: {
    title: string;
    body: string;
    businessIds?: string[];
    actorUserId: string;
    actorRole: string;
  }) {
    const nowMs = Date.now();
    if (nowMs - this.lastBroadcastAtMs < PUSH_BROADCAST_COOLDOWN_MS) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'BROADCAST_RATE_LIMITED',
          message:
            'Solo podés enviar un aviso masivo cada 5 minutos. Esperá un momento e intentá de nuevo.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.lastBroadcastAtMs = nowMs;

    const broadcastId = crypto.randomUUID();
    const cleanTitle = params.title.trim().slice(0, 100);
    const cleanBody = params.body.trim().slice(0, 200);

    let businessesTargeted = 0;
    let totalSent = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    const processBusiness = async (businessId: string) => {
      businessesTargeted++;
      if (!this.isEnabled()) {
        totalSkipped++;
        return;
      }
      try {
        const res = await this.send({
          businessId,
          roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
          category: PushCategory.AVISO_NEXOL,
          title: cleanTitle,
          body: cleanBody,
          data: {
            category: PushCategory.AVISO_NEXOL,
            screen: 'notifications',
            id: broadcastId,
          },
          dedupeKey: `broadcast:${broadcastId}:${businessId}`,
          dedupeWindowMinutes: 1440,
        });
        totalSent += res.sent || 0;
        totalFailed += res.failed || 0;
        totalSkipped +=
          typeof res.skipped === 'number' ? res.skipped : res.skipped ? 1 : 0;
      } catch (err: any) {
        totalFailed++;
        this.logger.warn(
          `[PushService.broadcast] Fallo enviando a negocio ${businessId}: ${err?.message || 'desconocido'}`,
        );
      }
    };

    if (params.businessIds && params.businessIds.length > 0) {
      const uniqueIds = Array.from(new Set(params.businessIds.filter(Boolean)));
      for (let i = 0; i < uniqueIds.length; i += PUSH_BATCH_BUSINESSES_SIZE) {
        const chunk = uniqueIds.slice(i, i + PUSH_BATCH_BUSINESSES_SIZE);
        for (const bid of chunk) {
          await processBusiness(bid);
        }
      }
    } else {
      let cursorId: string | undefined = undefined;
      while (true) {
        const subs = await this.prisma.businessProductSubscription.findMany({
          where: {
            productType: BusinessProductType.POS,
            status: BusinessProductStatus.ACTIVE,
            business: { isActive: true },
          },
          select: { id: true, businessId: true },
          orderBy: { id: 'asc' },
          take: PUSH_BATCH_BUSINESSES_SIZE,
          ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
        });
        if (subs.length === 0) break;
        for (const sub of subs) {
          await processBusiness(sub.businessId);
        }
        if (subs.length < PUSH_BATCH_BUSINESSES_SIZE) break;
        cursorId = subs[subs.length - 1].id;
      }
    }

    // Registrar auditoría de quién envió el broadcast (sin contenido de texto en pos_push_log)
    try {
      await this.auditService.record({
        businessId: params.businessIds?.[0] || 'system',
        userId: params.actorUserId,
        userRole: params.actorRole,
        action: 'PUSH_BROADCAST_SENT',
        entityType: 'PushBroadcast',
        entityId: broadcastId,
        after: {
          broadcastId,
          businessesTargeted,
          sent: totalSent,
          failed: totalFailed,
          skipped: totalSkipped,
          pushEnabled: this.isEnabled(),
        },
      });
    } catch {}

    return {
      broadcastId,
      businessesTargeted,
      sent: totalSent,
      failed: totalFailed,
      skipped: totalSkipped,
      pushEnabled: this.isEnabled(),
    };
  }

  /**
   * Envía notificaciones push por FCM HTTP v1.
   * NUNCA lanza excepciones hacia afuera: cualquier fallo se captura y se registra.
   */
  async send(input: SendPushInput): Promise<SendPushResult> {
    try {
      if (!input.businessId || !input.category) {
        return { sent: 0, failed: 0, skipped: 'INVALID_INPUT' };
      }

      if ((!this.isEnabled() || !this.messagingClient) && input.skipInbox) {
        return { sent: 0, failed: 0, skipped: 'PUSH_DISABLED' };
      }

      const dedupeKey = input.dedupeKey ? input.dedupeKey.trim().slice(0, 200) : null;
      const dedupeWindowMinutes = Math.max(
        1,
        Math.floor(input.dedupeWindowMinutes ?? DEFAULT_DEDUPE_WINDOW_MINUTES),
      );

      // Si hay dedupeKey, protegemos la ventana con advisory lock en Postgres (multi-instancia)
      if (dedupeKey) {
        const lockKey = this.computeInt32Hash(`${input.businessId}:${dedupeKey}`);
        await this.prisma.$executeRaw`
          SELECT pg_advisory_lock(${PUSH_DEDUPE_LOCK_NAMESPACE}::int, ${lockKey}::int)
        `;
        try {
          const alreadySent = await this.hasRecentDedupeSent(
            input.businessId,
            dedupeKey,
            dedupeWindowMinutes,
          );
          if (alreadySent) {
            await this.writePushLog({
              businessId: input.businessId,
              userId: null,
              deviceId: input.deviceId || null,
              category: input.category,
              dedupeKey,
              status: 'SKIPPED',
              errorCode: 'DEDUPED',
            });
            return { sent: 0, failed: 0, skipped: 'DEDUPED' };
          }

          return await this.executeSend(input, dedupeKey);
        } finally {
          await this.prisma.$executeRaw`
            SELECT pg_advisory_unlock(${PUSH_DEDUPE_LOCK_NAMESPACE}::int, ${lockKey}::int)
          `.catch(() => {});
        }
      }

      return await this.executeSend(input, null);
    } catch (err: any) {
      this.logger.error(
        `[PushService.send] Error inesperado al enviar push (category=${input?.category}, code=${err?.code || 'UNKNOWN'}): ${err?.message || 'desconocido'}`,
      );
      return {
        sent: 0,
        failed: 0,
        skipped: 0,
        error: 'INTERNAL_ERROR',
      };
    }
  }

  private async executeSend(
    input: SendPushInput,
    dedupeKey: string | null,
  ): Promise<SendPushResult> {
    // Contenido corto y sin datos personales; data estrictamente { category, screen, id }
    const safeTitle = String(input.title || '').trim().slice(0, 100);
    const safeBody = String(input.body || '').trim().slice(0, 200);
    const safeData: Record<string, string> = {
      category: String(input.data?.category || input.category),
      screen: String(input.data?.screen || ''),
      id: String(input.data?.id || ''),
    };

    // 300f: guardar en el historial por destinatario ANTES de intentar Firebase y aunque Firebase falle
    if (!input.skipInbox) {
      await this.recordUserNotifications(input, safeTitle, safeBody, safeData);
    }

    if (!this.isEnabled() || !this.messagingClient) {
      return { sent: 0, failed: 0, skipped: 'PUSH_DISABLED' };
    }

    const targets = await this.resolveTargets(input);

    if (targets.length === 0) {
      return { sent: 0, failed: 0, skipped: 0 };
    }

    // Cargar preferencias de los usuarios destino para esta categoría
    const distinctUserIds = Array.from(new Set(targets.map((t) => t.userId)));
    const prefRows =
      distinctUserIds.length > 0
        ? await this.prisma.$queryRaw<PreferenceRow[]>`
            SELECT "userId", "category", "enabled", "quietStart", "quietEnd"
            FROM "pos_push_preferences"
            WHERE "category" = ${input.category}
              AND "userId" = ANY(${distinctUserIds}::text[])
          `
        : [];

    const prefMap = new Map<string, PreferenceRow>();
    for (const p of prefRows) {
      prefMap.set(p.userId, p);
    }

    const isMandatory = MANDATORY_PUSH_CATEGORIES.has(input.category);
    const managuaNow = getManaguaDateParts(new Date());
    const currentMinutes = managuaNow.hour * 60 + managuaNow.minute;

    const eligibleTargets: ActiveTokenRow[] = [];
    let skippedCount = 0;

    for (const target of targets) {
      if (!isMandatory) {
        const pref = prefMap.get(target.userId);
        const isEnabled = pref
          ? Boolean(pref.enabled)
          : this.getDefaultEnabled(input.category);

        if (!isEnabled) {
          skippedCount++;
          await this.writePushLog({
            businessId: input.businessId,
            userId: target.userId,
            deviceId: target.deviceId,
            category: input.category,
            dedupeKey,
            status: 'SKIPPED',
            errorCode: 'PREFERENCE_DISABLED',
          });
          continue;
        }

        if (
          pref?.quietStart &&
          pref?.quietEnd &&
          this.isWithinQuietHours(currentMinutes, pref.quietStart, pref.quietEnd)
        ) {
          skippedCount++;
          await this.writePushLog({
            businessId: input.businessId,
            userId: target.userId,
            deviceId: target.deviceId,
            category: input.category,
            dedupeKey,
            status: 'SKIPPED',
            errorCode: 'QUIET_HOURS',
          });
          continue;
        }
      }

      eligibleTargets.push(target);
    }

    if (eligibleTargets.length === 0) {
      return { sent: 0, failed: 0, skipped: skippedCount };
    }

    const priority: 'high' | 'normal' = HIGH_PRIORITY_CATEGORIES.has(input.category)
      ? 'high'
      : 'normal';
    const channelId = input.category.toLowerCase();

    let sentCount = 0;
    let failedCount = 0;

    // Envío en lotes de hasta 500 tokens (límite de FCM HTTP v1 multicast)
    for (let i = 0; i < eligibleTargets.length; i += FCM_MULTICAST_BATCH_SIZE) {
      const batch = eligibleTargets.slice(i, i + FCM_MULTICAST_BATCH_SIZE);
      const batchTokens = batch.map((b) => b.token);

      const batchResponse = await this.messagingClient!.sendEachForMulticast({
        tokens: batchTokens,
        notification: {
          title: safeTitle,
          body: safeBody,
        },
        data: safeData,
        android: {
          priority,
          notification: {
            channelId,
            sound: 'default',
          },
        },
      });

      for (let j = 0; j < batch.length; j++) {
        const target = batch[j];
        const res = batchResponse.responses[j];

        if (res?.success) {
          sentCount++;
          await this.writePushLog({
            businessId: input.businessId,
            userId: target.userId,
            deviceId: target.deviceId,
            category: input.category,
            dedupeKey,
            status: 'SENT',
            errorCode: null,
          });
        } else {
          failedCount++;
          const errorCode = this.extractErrorCode(res?.error);
          const tokenTail = target.token ? target.token.slice(-6) : '??????';
          const willDeactivate = this.isInvalidTokenError(errorCode);
          this.logger.warn(
            `[PushService] Fallo FCM (category=${input.category}, deviceId=${target.deviceId}, token=...${tokenTail}, code=${errorCode}, deactivated=${willDeactivate})`,
          );
          await this.handleTokenSendError(target.id, errorCode);
          await this.writePushLog({
            businessId: input.businessId,
            userId: target.userId,
            deviceId: target.deviceId,
            category: input.category,
            dedupeKey,
            status: 'FAILED',
            errorCode,
          });
        }
      }
    }

    return {
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
    };
  }

  private async resolveTargets(input: SendPushInput): Promise<ActiveTokenRow[]> {
    let rows: ActiveTokenRow[] = [];

    if (input.deviceId) {
      if (input.allowRevokedDevice) {
        rows = await this.prisma.$queryRaw<ActiveTokenRow[]>`
          SELECT t."id", t."businessId", t."userId", t."deviceId", t."token", t."platform"
          FROM "pos_push_tokens" t
          INNER JOIN "pos_devices" d
            ON d."businessId" = t."businessId"
           AND d."deviceId" = t."deviceId"
           AND d."category" = 'MOBILE'
          WHERE t."businessId" = ${input.businessId}
            AND t."deviceId" = ${input.deviceId}
            AND t."isActive" = true
        `;
      } else {
        rows = await this.prisma.$queryRaw<ActiveTokenRow[]>`
          SELECT t."id", t."businessId", t."userId", t."deviceId", t."token", t."platform"
          FROM "pos_push_tokens" t
          INNER JOIN "users" u ON u."id" = t."userId" AND u."isActive" = true
          INNER JOIN "pos_devices" d
            ON d."businessId" = t."businessId"
           AND d."deviceId" = t."deviceId"
           AND d."category" = 'MOBILE'
           AND d."status" = 'ACTIVE'
          WHERE t."businessId" = ${input.businessId}
            AND t."deviceId" = ${input.deviceId}
            AND t."isActive" = true
        `;
      }
    } else if (input.userIds && input.userIds.length > 0) {
      rows = await this.prisma.$queryRaw<ActiveTokenRow[]>`
        SELECT t."id", t."businessId", t."userId", t."deviceId", t."token", t."platform"
        FROM "pos_push_tokens" t
        INNER JOIN "users" u ON u."id" = t."userId" AND u."isActive" = true
        INNER JOIN "pos_devices" d
          ON d."businessId" = t."businessId"
         AND d."deviceId" = t."deviceId"
         AND d."category" = 'MOBILE'
         AND d."status" = 'ACTIVE'
        WHERE t."businessId" = ${input.businessId}
          AND t."userId" = ANY(${input.userIds}::text[])
          AND t."isActive" = true
      `;
    } else if (input.roles && input.roles.length > 0) {
      const roleStrings = input.roles.map((r) => String(r));
      rows = await this.prisma.$queryRaw<ActiveTokenRow[]>`
        SELECT t."id", t."businessId", t."userId", t."deviceId", t."token", t."platform"
        FROM "pos_push_tokens" t
        INNER JOIN "users" u
          ON u."id" = t."userId"
         AND u."isActive" = true
         AND u."role"::text = ANY(${roleStrings}::text[])
        INNER JOIN "pos_devices" d
          ON d."businessId" = t."businessId"
         AND d."deviceId" = t."deviceId"
         AND d."category" = 'MOBILE'
         AND d."status" = 'ACTIVE'
        WHERE t."businessId" = ${input.businessId}
          AND t."isActive" = true
      `;
    }

    if (input.excludeUserIds && input.excludeUserIds.length > 0 && rows.length > 0) {
      const excluded = new Set(input.excludeUserIds);
      rows = rows.filter((r) => !excluded.has(r.userId));
    }

    return rows;
  }

  private async hasRecentDedupeSent(
    businessId: string,
    dedupeKey: string,
    windowMinutes: number,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM "pos_push_log"
      WHERE "businessId" = ${businessId}
        AND "dedupeKey" = ${dedupeKey}
        AND "status" = 'SENT'
        AND "createdAt" >= NOW() - make_interval(mins => ${windowMinutes}::int)
    `;
    return (rows[0]?.cnt || 0) > 0;
  }

  private extractErrorCode(error?: { code?: string; message?: string }): string {
    const raw = (error?.code || 'UNKNOWN_ERROR').toString().trim();
    return raw.slice(0, 100);
  }

  private isInvalidTokenError(errorCode: string): boolean {
    if (INVALID_FCM_TOKEN_ERRORS.has(errorCode)) {
      return true;
    }
    const upper = errorCode.toUpperCase();
    return (
      upper.includes('UNREGISTERED') ||
      upper.includes('INVALID_ARGUMENT') ||
      upper.includes('INVALID-REGISTRATION-TOKEN') ||
      upper.includes('REGISTRATION-TOKEN-NOT-REGISTERED')
    );
  }

  private async handleTokenSendError(tokenRowId: string, errorCode: string): Promise<void> {
    const shouldDeactivate = this.isInvalidTokenError(errorCode);
    if (shouldDeactivate) {
      await this.prisma.$executeRaw`
        UPDATE "pos_push_tokens"
        SET "isActive" = false,
            "lastErrorAt" = NOW(),
            "lastErrorCode" = ${errorCode},
            "updatedAt" = NOW()
        WHERE "id" = ${tokenRowId}
      `;
    } else {
      await this.prisma.$executeRaw`
        UPDATE "pos_push_tokens"
        SET "lastErrorAt" = NOW(),
            "lastErrorCode" = ${errorCode},
            "updatedAt" = NOW()
        WHERE "id" = ${tokenRowId}
      `;
    }
  }

  private async writePushLog(entry: {
    businessId: string;
    userId: string | null;
    deviceId: string | null;
    category: PushCategory;
    dedupeKey: string | null;
    status: 'SENT' | 'FAILED' | 'SKIPPED';
    errorCode: string | null;
  }): Promise<void> {
    const id = crypto.randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "pos_push_log" (
        "id", "businessId", "userId", "deviceId", "category",
        "dedupeKey", "status", "errorCode", "createdAt"
      ) VALUES (
        ${id}, ${entry.businessId}, ${entry.userId}, ${entry.deviceId}, ${entry.category},
        ${entry.dedupeKey}, ${entry.status}, ${entry.errorCode}, NOW()
      )
    `;
  }

  private parseTimeToMinutes(hhmm: string): number | null {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  }

  private isWithinQuietHours(
    currentMinutes: number,
    quietStart: string,
    quietEnd: string,
  ): boolean {
    const start = this.parseTimeToMinutes(quietStart);
    const end = this.parseTimeToMinutes(quietEnd);
    if (start === null || end === null || start === end) {
      return false;
    }
    if (start < end) {
      return currentMinutes >= start && currentMinutes < end;
    }
    // Ventana que cruza medianoche (ej. 22:00 a 07:00)
    return currentMinutes >= start || currentMinutes < end;
  }

  private computeInt32Hash(input: string): number {
    const digest = crypto.createHash('sha256').update(input).digest();
    return digest.readInt32BE(0);
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTORIAL DE AVISOS POR USUARIO (300f — pos_user_notifications)
  // ═══════════════════════════════════════════════════════════════

  private async resolveInboxRecipientUserIds(input: SendPushInput): Promise<string[]> {
    let userIds: string[] = [];

    if (input.userIds && input.userIds.length > 0) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "users"
        WHERE "businessId" = ${input.businessId}
          AND "isActive" = true
          AND "id" = ANY(${input.userIds}::text[])
      `;
      userIds = rows.map((r) => r.id);
    } else if (input.roles && input.roles.length > 0) {
      const roleStrings = input.roles.map((r) => String(r));
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "users"
        WHERE "businessId" = ${input.businessId}
          AND "isActive" = true
          AND "role"::text = ANY(${roleStrings}::text[])
      `;
      userIds = rows.map((r) => r.id);
    } else if (input.deviceId) {
      const rows = await this.prisma.$queryRaw<{ userId: string }[]>`
        SELECT DISTINCT t."userId"
        FROM "pos_push_tokens" t
        INNER JOIN "users" u ON u."id" = t."userId" AND u."isActive" = true
        WHERE t."businessId" = ${input.businessId}
          AND t."deviceId" = ${input.deviceId}
      `;
      userIds = rows.map((r) => r.userId);
    }

    const unique = Array.from(new Set(userIds));
    if (input.excludeUserIds && input.excludeUserIds.length > 0) {
      const excluded = new Set(input.excludeUserIds);
      return unique.filter((id) => !excluded.has(id));
    }
    return unique;
  }

  private async recordUserNotifications(
    input: SendPushInput,
    safeTitle: string,
    safeBody: string,
    safeData: Record<string, string>,
  ): Promise<void> {
    try {
      const recipientUserIds = await this.resolveInboxRecipientUserIds(input);
      if (recipientUserIds.length === 0) return;

      const isMandatory = MANDATORY_PUSH_CATEGORIES.has(input.category);
      let eligibleUserIds = recipientUserIds;

      if (!isMandatory) {
        const prefRows = await this.prisma.$queryRaw<
          { userId: string; enabled: boolean }[]
        >`
          SELECT "userId", "enabled"
          FROM "pos_push_preferences"
          WHERE "category" = ${input.category}
            AND "userId" = ANY(${recipientUserIds}::text[])
        `;
        const prefMap = new Map<string, boolean>();
        for (const p of prefRows) {
          prefMap.set(p.userId, Boolean(p.enabled));
        }

        const defaultEnabled = this.getDefaultEnabled(input.category);
        eligibleUserIds = recipientUserIds.filter((uid) => {
          if (prefMap.has(uid)) {
            return prefMap.get(uid) === true;
          }
          return defaultEnabled;
        });
      }

      if (eligibleUserIds.length === 0) return;

      const dataJson = JSON.stringify(safeData);
      const now = new Date();
      for (const uid of eligibleUserIds) {
        const id = crypto.randomUUID();
        await this.prisma.$executeRaw`
          INSERT INTO "pos_user_notifications" (
            "id", "businessId", "userId", "category", "title", "body", "data", "createdAt", "readAt"
          ) VALUES (
            ${id}, ${input.businessId}, ${uid}, ${input.category},
            ${safeTitle}, ${safeBody}, ${dataJson}::jsonb, ${now}, NULL
          )
        `;
      }
    } catch (err: any) {
      this.logger.warn(
        `[PushService.recordUserNotifications] Error guardando historial (category=${input.category}): ${err?.message || 'desconocido'}`,
      );
    }
  }

  private encodeInboxCursor(createdAt: Date, id: string): string {
    return Buffer.from(
      JSON.stringify({ c: createdAt.toISOString(), i: id }),
      'utf8',
    ).toString('base64url');
  }

  private decodeInboxCursor(raw?: string): { createdAt: Date; id: string } | null {
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(raw.trim(), 'base64url').toString('utf8'),
      ) as { c?: unknown; i?: unknown };
      if (typeof parsed?.c !== 'string' || typeof parsed?.i !== 'string' || !parsed.i) {
        throw new Error('invalid');
      }
      const dt = new Date(parsed.c);
      if (Number.isNaN(dt.getTime())) {
        throw new Error('invalid_date');
      }
      return { createdAt: dt, id: parsed.i };
    } catch {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_CURSOR',
        message: 'El cursor de paginación no es válido.',
      });
    }
  }

  async listInbox(
    businessId: string,
    userId: string,
    cursor?: string,
    takeRaw?: number,
  ) {
    const safeTake = Number.isFinite(takeRaw)
      ? Math.min(PUSH_INBOX_MAX_TAKE, Math.max(1, Math.floor(takeRaw!)))
      : PUSH_INBOX_DEFAULT_TAKE;
    const decoded = this.decodeInboxCursor(cursor);

    type InboxRow = {
      id: string;
      category: string;
      title: string;
      body: string;
      data: Record<string, string> | null;
      createdAt: Date;
      readAt: Date | null;
    };

    const cursorIso = decoded ? decoded.createdAt.toISOString() : null;
    const [rows, unreadRes] = await Promise.all([
      decoded && cursorIso
        ? this.prisma.$queryRaw<InboxRow[]>`
            SELECT "id", "category", "title", "body", "data", "createdAt", "readAt"
            FROM "pos_user_notifications"
            WHERE "businessId" = ${businessId}
              AND "userId" = ${userId}
              AND (
                "createdAt" < ${cursorIso}::timestamp(3)
                OR ("createdAt" = ${cursorIso}::timestamp(3) AND "id" < ${decoded.id})
              )
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT ${safeTake + 1}
          `
        : this.prisma.$queryRaw<InboxRow[]>`
            SELECT "id", "category", "title", "body", "data", "createdAt", "readAt"
            FROM "pos_user_notifications"
            WHERE "businessId" = ${businessId}
              AND "userId" = ${userId}
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT ${safeTake + 1}
          `,
      this.getInboxUnreadCount(businessId, userId),
    ]);

    const hasMore = rows.length > safeTake;
    const pageRows = hasMore ? rows.slice(0, safeTake) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow ? this.encodeInboxCursor(lastRow.createdAt, lastRow.id) : null;

    return {
      items: pageRows.map((r) => ({
        id: r.id,
        category: r.category,
        title: r.title,
        body: r.body,
        data: r.data || {},
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt ? r.readAt.toISOString() : null,
      })),
      unreadCount: unreadRes.unreadCount,
      nextCursor,
    };
  }

  async getInboxUnreadCount(
    businessId: string,
    userId: string,
  ): Promise<{ unreadCount: number }> {
    const rows = await this.prisma.$queryRaw<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt
      FROM "pos_user_notifications"
      WHERE "businessId" = ${businessId}
        AND "userId" = ${userId}
        AND "readAt" IS NULL
    `;
    return { unreadCount: rows[0]?.cnt || 0 };
  }

  async markInboxItemRead(
    businessId: string,
    userId: string,
    notificationId: string,
  ) {
    const now = new Date();
    const updated = await this.prisma.$queryRaw<{ id: string; readAt: Date }[]>`
      UPDATE "pos_user_notifications"
      SET "readAt" = COALESCE("readAt", ${now})
      WHERE "id" = ${notificationId}
        AND "businessId" = ${businessId}
        AND "userId" = ${userId}
      RETURNING "id", "readAt"
    `;

    if (updated.length === 0) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Aviso no encontrado.',
      });
    }

    const { unreadCount } = await this.getInboxUnreadCount(businessId, userId);
    return {
      success: true,
      id: updated[0].id,
      readAt: updated[0].readAt.toISOString(),
      unreadCount,
    };
  }

  async markAllInboxRead(businessId: string, userId: string) {
    const now = new Date();
    const marked = await this.prisma.$executeRaw`
      UPDATE "pos_user_notifications"
      SET "readAt" = ${now}
      WHERE "businessId" = ${businessId}
        AND "userId" = ${userId}
        AND "readAt" IS NULL
    `;
    return {
      success: true,
      markedCount: Number(marked) || 0,
      unreadCount: 0,
    };
  }

  async cleanupOldUserNotifications(): Promise<{ deleted: number }> {
    try {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM "pos_user_notifications"
        WHERE "createdAt" < NOW() - make_interval(days => ${PUSH_INBOX_RETENTION_DAYS}::int)
      `;
      const count = Number(deleted) || 0;
      if (count > 0) {
        this.logger.log(
          `[PushService] Limpieza de pos_user_notifications: ${count} avisos antiguos (> ${PUSH_INBOX_RETENTION_DAYS} días) eliminados.`,
        );
      }
      return { deleted: count };
    } catch (err: any) {
      this.logger.warn(
        `[PushService] Error en limpieza de pos_user_notifications: ${err?.message || 'desconocido'}`,
      );
      return { deleted: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LIMPIEZA AUTOMÁTICA DE LOGS (> 30 DÍAS)
  // ═══════════════════════════════════════════════════════════════

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupOldPushLogs(): Promise<{ deleted: number }> {
    try {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM "pos_push_log"
        WHERE "createdAt" < NOW() - make_interval(days => ${PUSH_LOG_RETENTION_DAYS}::int)
      `;
      const count = Number(deleted) || 0;
      if (count > 0) {
        this.logger.log(
          `[PushService] Limpieza diaria de pos_push_log: ${count} registros antiguos (> ${PUSH_LOG_RETENTION_DAYS} días) eliminados.`,
        );
      }
      return { deleted: count };
    } catch (err: any) {
      this.logger.warn(
        `[PushService] Error en limpieza de pos_push_log: ${err?.message || 'desconocido'}`,
      );
      return { deleted: 0 };
    }
  }
}
