import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import { traceContext, TraceContextData } from '../trace-context';

@Injectable()
export class TraceInterceptor implements NestInterceptor {
  private readonly logger = new Logger('TraceInterceptor');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (process.env.TRACE_ENABLED !== 'true') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const requestId = req.headers['x-request-id'] || uuidv4();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    const startTime = Date.now();
    const traceData: TraceContextData = { requestId, queryCount: 0, queryTimeMs: 0 };

    return new Observable((subscriber) => {
      traceContext.run(traceData, () => {
        next.handle().pipe(
          tap({
            next: (data) => this.logTrace(req, res, data, startTime, traceData),
            error: (err) => this.logTrace(req, res, null, startTime, traceData, err),
          }),
        ).subscribe(subscriber);
      });
    });
  }

  private logTrace(req: any, res: any, data: any, startTime: number, traceData: TraceContextData, err?: any) {
    const duration = Date.now() - startTime;
    const status = err ? (err.status || err.statusCode || 500) : res.statusCode;
    
    let resSize = 0;
    if (data) {
      try {
        resSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
      } catch (e) {}
    }

    const dbQueriesCount = traceData.queryCount;
    const dbQueriesTime = traceData.queryTimeMs;

    const user = req.user;
    const userId = user ? user.sub : null;
    const businessId = user ? user.businessId : null;
    const role = user ? user.role : null;
    const client = req.headers['x-client'] || req.headers['user-agent'] || 'unknown';
    const route = req.route ? req.route.path : req.url;

    const logEntry = {
      requestId: traceData.requestId,
      method: req.method,
      route,
      status,
      durationMs: duration,
      resSizeBytes: resSize,
      userId,
      businessId,
      role,
      client,
      dbQueriesCount,
      dbQueriesTimeMs: dbQueriesTime
    };

    this.logger.log(JSON.stringify(logEntry));

    const timingParts = [
      `total;dur=${duration}`,
      `db;dur=${dbQueriesTime}`
    ];
    
    res.setHeader('Server-Timing', timingParts.join(', '));
    
    if ((global as any).LatencyDiagnostics) {
      (global as any).LatencyDiagnostics.record(route, duration, dbQueriesCount, status);
    }
  }
}

