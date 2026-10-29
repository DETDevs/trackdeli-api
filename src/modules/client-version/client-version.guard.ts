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

    const clientVersion = String(rawVersion || '').trim();

    // 5. Venta en dos pasos (213a):
    // Si el negocio tiene venta en dos pasos activa y el usuario es CAJERO o VENDEDOR,
    // validar la versión mínima configurada para el modo. Si no hay ninguna configurada para el modo, no se bloquea a nadie.
    let isTwoStepModeActive = false;
    let userRole: string | undefined = (req as any).user?.role;
    let businessId: string | undefined = (req as any).user?.businessId;

    if (!userRole || !businessId) {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const parts = authHeader.split(' ')[1].split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            businessId = businessId || payload.businessId;
            userRole = userRole || payload.role;
          }
        } catch {}
      }
    }

    if (businessId && (userRole === 'CAJERO' || userRole === 'VENDEDOR')) {
      isTwoStepModeActive = await this.clientVersionService.isTwoStepSaleEnabled(businessId);
    }

    if (isTwoStepModeActive) {
      const twoStepMinVersion = await this.clientVersionService.getTwoStepMinVersion(platform);
      if (twoStepMinVersion && twoStepMinVersion.trim() !== '') {
        if (!clientVersion || compareSemver(clientVersion, twoStepMinVersion) < 0) {
          this.logger.warn(
            `[ClientVersionGuard] 426 CLIENT_UPDATE_REQUIRED (venta en dos pasos): plataforma="${platform}", versionActual="${clientVersion || 'desconocida'}", versionMinima="${twoStepMinVersion}", ruta="${rawUrl}"`,
          );

          throw new HttpException(
            {
              statusCode: HTTP_STATUS_UPGRADE_REQUIRED,
              error: 'Upgrade Required',
              code: 'CLIENT_UPDATE_REQUIRED',
              message: 'Actualizá el POS de escritorio para usar la venta en dos pasos.',
              minVersion: twoStepMinVersion,
              currentVersion: clientVersion || 'unknown',
            },
            HTTP_STATUS_UPGRADE_REQUIRED,
          );
        }
      }
    }

    // 6. Validación de versión mínima general de la plataforma
    const minVersion = await this.clientVersionService.getMinVersion(platform);
    if (!minVersion || minVersion.trim() === '') {
      return true;
    }

    // Comparación semver: si clientVersion es menor a minVersion -> 426 Upgrade Required
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
