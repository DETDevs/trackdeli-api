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
    const platform = (
      req.headers['x-client-platform'] ||
      req.headers['X-Client-Platform'] ||
      ''
    )
      .toString()
      .toLowerCase();

    if (platform.startsWith('web')) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'NOT_AVAILABLE_ON_WEB',
        message: 'Las devoluciones y anulaciones no están disponibles desde la web',
      });
    }

    return true;
  }
}
