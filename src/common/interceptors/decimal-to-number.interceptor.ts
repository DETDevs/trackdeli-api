import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Prisma } from '@prisma/client';

@Injectable()
export class DecimalToNumberInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => this.transform(data)),
    );
  }

  private transform(value: any, seen = new WeakSet<object>()): any {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      return value;
    }

    if (typeof (value as any).pipe === 'function') {
      return value;
    }

    // Identificar y convertir instancias de Prisma.Decimal / Decimal.js a number
    if (
      Prisma.Decimal.isDecimal(value) ||
      (typeof value.toNumber === 'function' &&
        typeof value.toFixed === 'function' &&
        !Array.isArray(value))
    ) {
      return value.toNumber();
    }

    // Prevenir bucles infinitos en referencias circulares
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.transform(item, seen));
    }

    const copy: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      copy[key] = this.transform(value[key], seen);
    }
    return copy;
  }
}
