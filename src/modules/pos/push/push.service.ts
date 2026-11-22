import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { getManaguaDateParts } from '../../superadmin/utils/membership-billing.util';
import {
  ALL_PUSH_CATEGORIES,
  DEFAULT_DEDUPE_WINDOW_MINUTES,
  DEFAULT_DISABLED_CATEGORIES,
  FCM_MULTICAST_BATCH_SIZE,
  HIGH_PRIORITY_CATEGORIES,
  INVALID_FCM_TOKEN_ERRORS,
  MANDATORY_PUSH_CATEGORIES,
  PUSH_DEDUPE_LOCK_NAMESPACE,
  PUSH_FIREBASE_APP_NAME,
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
  deviceId?: string;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.initializeFirebase();
  }

  /**
   * Inicializa Firebase Admin SDK con FIREBASE_SERVICE_ACCOUNT_JSON.
   * Nunca imprime ni expone la credencial en logs ni errores.
   * Si no existe o es inválida, el servicio queda apagado y el API arranca normal.
   */
  private initializeFirebase(): void {
    const rawJson =
      this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_JSON') ||
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      '';

    if (!rawJson || !rawJson.trim()) {
      this.enabled = false;
      this.messagingClient = null;
      this.logger.warn(
        '[PushService] Notificaciones push desactivadas: variable FIREBASE_SERVICE_ACCOUNT_JSON no configurada.',
      );
      return;
    }

    try {
      const parsed = JSON.parse(rawJson.trim());
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.project_id !== 'string' ||
        typeof parsed.client_email !== 'string' ||
        typeof parsed.private_key !== 'string' ||
        !parsed.project_id.trim() ||
        !parsed.client_email.trim() ||
        !parsed.private_key.trim()
      ) {
        this.enabled = false;
        this.messagingClient = null;
        this.logger.warn(
          '[PushService] Notificaciones push desactivadas: FIREBASE_SERVICE_ACCOUNT_JSON incompleto o con formato inválido.',
        );
        return;
      }

      const existing = admin.apps.find((a) => a?.name === PUSH_FIREBASE_APP_NAME);
      if (existing) {
        this.firebaseApp = existing;
      } else {
        this.firebaseApp = admin.initializeApp(
          {
            credential: admin.credential.cert(parsed),
          },
          PUSH_FIREBASE_APP_NAME,
        );
      }

      this.messagingClient = this.firebaseApp.messaging() as unknown as FcmMessagingClient;
      this.enabled = true;
      this.logger.log(
        '[PushService] Servicio de notificaciones push inicializado correctamente (FCM HTTP v1).',
      );
    } catch {
      this.enabled = false;
      this.messagingClient = null;
      this.logger.warn(
        '[PushService] Notificaciones push desactivadas: no se pudo parsear o inicializar FIREBASE_SERVICE_ACCOUNT_JSON.',
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
   * Envía notificaciones push por FCM HTTP v1.
   * NUNCA lanza excepciones hacia afuera: cualquier fallo se captura y se registra.
   */
  async send(input: SendPushInput): Promise<SendPushResult> {
    try {
      if (!this.isEnabled() || !this.messagingClient) {
        return { sent: 0, failed: 0, skipped: 'PUSH_DISABLED' };
      }

      if (!input.businessId || !input.category) {
        return { sent: 0, failed: 0, skipped: 'INVALID_INPUT' };
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
        `[PushService.send] Error inesperado al enviar push (category=${input?.category}): ${err?.message || 'desconocido'}`,
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

    // Contenido corto y sin datos personales; data estrictamente { category, screen, id }
    const safeTitle = String(input.title || '').trim().slice(0, 100);
    const safeBody = String(input.body || '').trim().slice(0, 200);
    const safeData: Record<string, string> = {
      category: String(input.data?.category || input.category),
      screen: String(input.data?.screen || ''),
      id: String(input.data?.id || ''),
    };

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
    if (input.deviceId) {
      return this.prisma.$queryRaw<ActiveTokenRow[]>`
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

    if (input.userIds && input.userIds.length > 0) {
      return this.prisma.$queryRaw<ActiveTokenRow[]>`
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
    }

    if (input.roles && input.roles.length > 0) {
      const roleStrings = input.roles.map((r) => String(r));
      return this.prisma.$queryRaw<ActiveTokenRow[]>`
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

    return [];
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
