import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';

@Injectable()
export class NoWebPlatformGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const rawPlatform =
      req.headers['x-client-platform'] || req.headers['X-Client-Platform'];

    if (!rawPlatform || !rawPlatform.toString().trim()) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_REQUIRED',
        message: 'Cabecera de plataforma requerida (X-Client-Platform)',
      });
    }

    const platform = rawPlatform.toString().toLowerCase();
    if (platform.startsWith('web')) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'NOT_AVAILABLE_ON_WEB',
        message: 'Esta acción no está disponible desde la web',
      });
    }

    return true;
  }
}
