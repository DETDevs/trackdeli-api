import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  BadRequestException,
  ConflictException,
  Logger
} from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { PrismaService } from '../../../prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private readonly EXPIRATION_HOURS = 24;

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['idempotency-key'];

    // Si no hay llave, simplemente procesa la solicitud
    if (!idempotencyKey) {
      return next.handle();
    }

    // Calculamos hash del body para evitar reutilización fraudulenta con cuerpos distintos
    const bodyString = JSON.stringify(request.body || {});
    const requestHash = crypto.createHash('sha256').update(bodyString).digest('hex');
    const businessId = request.query.businessId || request.user?.businessId || request.user?.id;

    if (!businessId) {
      // Sin businessId no podemos particionar la idempotencia
      return next.handle();
    }

    try {
      // 1. Buscamos si ya existe
      const existingKey = await this.prisma.idempotencyKey.findUnique({
        where: {
          businessId_key: {
            businessId,
            key: idempotencyKey,
          }
        }
      });

      if (existingKey) {
        // Verificar expiración
        if (new Date() > existingKey.expiresAt) {
          // Si expiró, la borramos y seguimos como nueva
          await this.prisma.idempotencyKey.delete({ where: { id: existingKey.id } });
        } else {
          // Verificar Hash del body
          if (existingKey.requestHash !== requestHash) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: {
                code: 'IDEMPOTENCY_KEY_REUSED',
                message: 'La Idempotency-Key ya fue usada con un body diferente.'
              }
            });
          }

          // Retornar la respuesta cacheada
          this.logger.debug(`[Idempotency] Devolviendo respuesta cacheada para key: ${idempotencyKey}`);
          const res = context.switchToHttp().getResponse();
          res.status(existingKey.statusCode);
          return of(existingKey.responseBody);
        }
      }

      // 2. Si no existe, guardamos un registro preliminar (statusCode 0 significa en proceso)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + this.EXPIRATION_HOURS);

      const record = await this.prisma.idempotencyKey.create({
        data: {
          businessId,
          key: idempotencyKey,
          requestHash,
          statusCode: 0,
          responseBody: {},
          expiresAt
        }
      });

      // 3. Procesar y guardar el resultado
      return next.handle().pipe(
        tap(async (responseBody) => {
          const res = context.switchToHttp().getResponse();
          await this.prisma.idempotencyKey.update({
            where: { id: record.id },
            data: {
              statusCode: res.statusCode,
              responseBody: responseBody || {}
            }
          }).catch(err => this.logger.error(`Error guardando idempotencia: ${err.message}`));
        }),
        catchError((err) => {
          // Si hubo error, eliminamos la llave para que se pueda reintentar
          this.prisma.idempotencyKey.delete({ where: { id: record.id } })
            .catch(deleteErr => this.logger.error(`Error limpiando idempotencia fallida: ${deleteErr.message}`));
          return throwError(() => err);
        })
      );
    } catch (e) {
      // Si la BD falla o hay ConflictException, lo lanzamos
      if (e instanceof ConflictException) {
        return throwError(() => e);
      }
      this.logger.error(`Error en idempotency interceptor: ${e.message}`);
      return next.handle();
    }
  }
}
