import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();
    const { method, url, user } = req;

    if (url.includes('/health')) {
      return next.handle();
    }

    const userId = user?.sub ?? 'anon';
    const start = Date.now();

    this.logger.log(`→ ${method} ${url} | userId=${userId}`);

    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - start;
        const res = context.switchToHttp().getResponse();
        const statusCode = res.statusCode;
        this.logger.log(
          `← ${method} ${url} | ${statusCode} | ${ms}ms | userId=${userId}`
        );
        Sentry.logger.info(`← ${method} ${url} [${statusCode}] ${ms}ms`, {
          method,
          url,
          statusCode,
          durationMs: ms,
          userId,
        });
      }),
      catchError((error) => {
        const ms = Date.now() - start;
        const status = error.status ?? error.statusCode ?? 500;
        this.logger.error(
          `← ${method} ${url} | ${status} | ${ms}ms | userId=${userId} | ${error.message}`,
          status >= 500 ? error.stack : undefined
        );
        if (status >= 500) {
          Sentry.logger.error(`← ${method} ${url} [${status}] ${ms}ms | ${error.message}`, {
            method,
            url,
            statusCode: status,
            durationMs: ms,
            userId,
            error: error.message,
          });
        } else {
          Sentry.logger.warn(`← ${method} ${url} [${status}] ${ms}ms | ${error.message}`, {
            method,
            url,
            statusCode: status,
            durationMs: ms,
            userId,
          });
        }
        return throwError(() => error);
      }),
    );
  }
}

