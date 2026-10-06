import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  DEFAULT_PLATFORM,
  HTTP_STATUS_UPGRADE_REQUIRED,
  KNOWN_PLATFORMS,
  SKIP_CLIENT_VERSION_CHECK_KEY,
} from './client-version.constants';
import { ClientVersionService } from './client-version.service';
import { compareSemver } from './utils/semver.util';

@Injectable()
export class ClientVersionGuard implements CanActivate {
  private readonly logger = new Logger(ClientVersionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly clientVersionService: ClientVersionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    // 1. Peticiones OPTIONS (CORS preflight) nunca se bloquean
    if (req.method === 'OPTIONS') {
      return true;
    }

    // 2. Comprobar decorador @SkipClientVersionCheck()
    const skipCheck = this.reflector.getAllAndOverride<boolean>(
      SKIP_CLIENT_VERSION_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skipCheck) {
      return true;
    }

    // 3. Excepciones obligatorias por ruta:
    // Nunca bloquear GET /health, login ni rutas de actualización/versión
    const rawUrl = (req.originalUrl || req.url || '').split('?')[0].toLowerCase();
    if (this.isExemptRoute(rawUrl)) {
      return true;
    }

    // 4. Leer encabezados de cliente
    const rawPlatform =
      req.headers['x-client-platform'] || (req.headers as any)['X-Client-Platform'];
    const rawVersion =
      req.headers['x-client-version'] || (req.headers as any)['X-Client-Version'];

    // Si la petición NO trae los encabezados (otros clientes, web, apps móviles), no se bloquea.
    if (!rawPlatform && !rawVersion) {
      return true;
    }

    const platform = String(rawPlatform || '').trim().toLowerCase();

    // Si trae una plataforma no conocida (ej. web, mobile), no se bloquea.
    const isKnownPlatform =
      KNOWN_PLATFORMS.includes(platform) || platform.startsWith('desktop-');
    if (!platform || !isKnownPlatform) {
      return true;
    }

    // 5. Consultar versión mínima configurada
    const minVersion = await this.clientVersionService.getMinVersion(platform);

    // Por defecto vacía = sin restricción
    if (!minVersion || minVersion.trim() === '') {
      return true;
    }

    const clientVersion = String(rawVersion || '').trim();

    // 6. Comparación semver: si clientVersion es menor a minVersion -> 426 Upgrade Required
    if (!clientVersion || compareSemver(clientVersion, minVersion) < 0) {
      this.logger.warn(
        `[ClientVersionGuard] 426 CLIENT_UPDATE_REQUIRED: plataforma="${platform}", versionActual="${clientVersion || 'desconocida'}", versionMinima="${minVersion}", ruta="${rawUrl}"`,
      );

      throw new HttpException(
        {
          statusCode: HTTP_STATUS_UPGRADE_REQUIRED,
          error: 'Upgrade Required',
          code: 'CLIENT_UPDATE_REQUIRED',
          message: `Se requiere actualizar la aplicación de escritorio a la versión ${minVersion} o superior para continuar operando.`,
          minVersion,
          currentVersion: clientVersion || 'unknown',
        },
        HTTP_STATUS_UPGRADE_REQUIRED,
      );
    }

    return true;
  }

  private isExemptRoute(path: string): boolean {
    const normalized = path.replace(/\/+$/, '');
    return (
      normalized.endsWith('/health') ||
      normalized.includes('/health/') ||
      normalized.includes('/auth/login') ||
      normalized.includes('/auth/refresh') ||
      normalized.includes('/superadmin/client-version') ||
      normalized.includes('/client-version')
    );
  }
}
