import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_PLATFORM, SETTING_KEY_PREFIX } from './client-version.constants';
import { cleanSemver } from './utils/semver.util';

interface CachedVersion {
  minVersion: string;
  expiresAt: number;
}

export interface SetMinVersionParams {
  platform?: string;
  minVersion: string;
  userId: string;
  userRole: string;
  businessId?: string | null;
  reason?: string;
  ipAddress?: string;
}

@Injectable()
export class ClientVersionService {
  private readonly logger = new Logger(ClientVersionService.name);
  private readonly cache = new Map<string, CachedVersion>();
  private readonly CACHE_TTL_MS = 10000; // 10 segundos

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obtiene la versión mínima configurada para una plataforma.
   * Prioridad:
   * 1. Base de datos (tabla platform_settings, clave min_version:<platform>)
   * 2. Variable de entorno (MIN_CLIENT_VERSION_<PLATFORM> o MIN_CLIENT_VERSION_DESKTOP_WIN)
   * 3. Cadena vacía (sin restricción por defecto)
   */
  async getMinVersion(platform: string = DEFAULT_PLATFORM): Promise<string> {
    const normalizedPlatform = (platform || DEFAULT_PLATFORM).trim().toLowerCase();

    // 1. Revisar caché en memoria
    const cached = this.cache.get(normalizedPlatform);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.minVersion;
    }

    let minVersion = '';

    // 2. Consultar tabla platform_settings
    try {
      const setting = await this.prisma.platformSetting.findUnique({
        where: { key: `${SETTING_KEY_PREFIX}${normalizedPlatform}` },
      });

      if (setting && setting.value !== undefined && setting.value !== null) {
        minVersion = cleanSemver(setting.value);
      }
    } catch (err: any) {
      this.logger.warn(
        `[ClientVersionService] No se pudo leer platform_settings para ${normalizedPlatform}: ${err.message}`,
      );
    }

    // 3. Fallback a variable de entorno si no está en BD
    if (!minVersion) {
      minVersion = cleanSemver(this.getEnvMinVersion(normalizedPlatform));
    }

    // Guardar en caché
    this.cache.set(normalizedPlatform, {
      minVersion,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return minVersion;
  }

  /**
   * Retorna los detalles de configuración de la versión mínima para una plataforma.
   */
  async getSettingDetails(platform: string = DEFAULT_PLATFORM) {
    const normalizedPlatform = (platform || DEFAULT_PLATFORM).trim().toLowerCase();

    let setting: any = null;
    try {
      setting = await this.prisma.platformSetting.findUnique({
        where: { key: `${SETTING_KEY_PREFIX}${normalizedPlatform}` },
      });
    } catch (err: any) {
      this.logger.warn(
        `[ClientVersionService] Error al consultar platform_settings para ${normalizedPlatform}: ${err.message}`,
      );
    }

    const envVersion = cleanSemver(this.getEnvMinVersion(normalizedPlatform));
    const hasDbSetting = setting && setting.value !== undefined && setting.value !== null;
    const minVersion = hasDbSetting ? cleanSemver(setting.value) : envVersion;
    const source = hasDbSetting ? 'database' : envVersion ? 'env' : 'default';

    return {
      platform: normalizedPlatform,
      minVersion,
      source,
      updatedAt: setting?.updatedAt || null,
      updatedByUserId: setting?.updatedByUserId || null,
    };
  }

  /**
   * Guarda o actualiza la versión mínima compatible y registra la auditoría en pos_audit_logs.
   */
  async setMinVersion(params: SetMinVersionParams) {
    const normalizedPlatform = (params.platform || DEFAULT_PLATFORM).trim().toLowerCase();
    const cleanVersion = params.minVersion ? cleanSemver(params.minVersion) : '';
    const key = `${SETTING_KEY_PREFIX}${normalizedPlatform}`;

    // Obtener versión anterior para el registro de auditoría
    const previous = await this.getSettingDetails(normalizedPlatform);
    const oldVersion = previous.minVersion || '';

    // Guardar en tabla platform_settings
    const updated = await this.prisma.platformSetting.upsert({
      where: { key },
      create: {
        key,
        value: cleanVersion,
        description: `Versión mínima compatible para cliente ${normalizedPlatform}`,
        updatedByUserId: params.userId,
      },
      update: {
        value: cleanVersion,
        updatedByUserId: params.userId,
      },
    });

    // Registrar en pos_audit_logs
    try {
      await this.prisma.posAuditLog.create({
        data: {
          businessId: params.businessId || 'system',
          userId: params.userId,
          userRole: params.userRole,
          action: 'UPDATE_MIN_CLIENT_VERSION',
          entityType: 'PLATFORM_SETTING',
          entityId: normalizedPlatform,
          before: { minVersion: oldVersion || null },
          after: { minVersion: cleanVersion || null },
          reason: params.reason || `Actualización de versión mínima para ${normalizedPlatform}`,
          ipAddress: params.ipAddress || null,
        },
      });
      this.logger.log(
        `[pos_audit_logs] Registrado cambio de versión mínima para ${normalizedPlatform}: "${oldVersion}" -> "${cleanVersion}" por usuario ${params.userId}`,
      );
    } catch (auditErr: any) {
      this.logger.error(
        `[ClientVersionService] Error al registrar en pos_audit_logs: ${auditErr.message}`,
        auditErr.stack,
      );
    }

    // Actualizar caché en memoria inmediatamente
    this.cache.set(normalizedPlatform, {
      minVersion: cleanVersion,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return {
      platform: normalizedPlatform,
      minVersion: cleanVersion,
      updatedAt: updated.updatedAt,
      updatedByUserId: params.userId,
    };
  }

  private getEnvMinVersion(platform: string): string {
    const specificKey = `MIN_CLIENT_VERSION_${platform.replace(/[-]/g, '_').toUpperCase()}`;
    return (
      process.env[specificKey] ||
      process.env.MIN_CLIENT_VERSION_DESKTOP_WIN ||
      process.env.CLIENT_MIN_VERSION_DESKTOP_WIN ||
      ''
    ).trim();
  }
}
