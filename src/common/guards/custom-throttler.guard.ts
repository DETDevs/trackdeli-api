import { Injectable, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (req.user && req.user.sub) {
      return `${req.user.businessId || 'no-business'}-${req.user.sub}`;
    }
    return req.ips?.length ? req.ips[0] : req.ip;
  }

  protected async handleRequest(requestProps: any): Promise<boolean> {
    const { context, limit } = requestProps;
    const req = context.switchToHttp().getRequest();
    const route = req.route ? req.route.path : req.url;

    // Excluir health
    if (route === '/api/v1/health' || route === '/api/v1/health/deep' || route === '/health' || route === '/health/deep') {
      return true;
    }

    // Aumentar límite para usuarios autenticados (600 por minuto)
    let actualLimit = limit;
    if (req.user) {
      actualLimit = 600;
    }

    requestProps.limit = actualLimit;
    return super.handleRequest(requestProps);
  }

  protected async throwThrottlingException(context: ExecutionContext, throttlerLimitDetail: any): Promise<void> {
    const res = context.switchToHttp().getResponse();
    res.header('Retry-After', '60');
    
    throw new HttpException(
      {
        code: 'RATE_LIMITED',
        message: 'Demasiadas peticiones. Por favor, espere un momento.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
