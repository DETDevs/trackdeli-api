import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SentryExceptionCaptured } from '@sentry/nestjs';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  @SentryExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const userId = request.user?.sub ?? 'anon';
    const bodyStr = request.body ? JSON.stringify(request.body) : '{}';

    let status: number;
    let message: any;
    let technicalLogDetail: string | null = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.getResponse();
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      technicalLogDetail = `Prisma ${exception.code} meta=${JSON.stringify(exception.meta ?? {})} | ${exception.message}`;
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        message = {
          error: 'Conflict',
          code: 'DUPLICATE',
          message: 'Ya existe un registro con ese dato.',
        };
      } else if (exception.code === 'P2003') {
        status = HttpStatus.BAD_REQUEST;
        message = {
          error: 'Bad Request',
          code: 'RELATED_NOT_FOUND',
          message: 'Uno de los datos relacionados ya no existe.',
        };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message = {
          error: 'Not Found',
          code: 'NOT_FOUND',
          message: 'No se encontró el registro.',
        };
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        message = {
          error: 'Internal Server Error',
          code: 'UNKNOWN_ERROR',
          message: 'Ocurrió un error inesperado. Intentá de nuevo.',
        };
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = {
        error: 'Internal Server Error',
        code: 'UNKNOWN_ERROR',
        message: 'Ocurrió un error inesperado. Intentá de nuevo.',
      };
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} | body=${bodyStr} | userId=${userId}${technicalLogDetail ? ` | ${technicalLogDetail}` : ''}`,
        exception instanceof Error ? exception.stack : String(exception)
      );
    } else if (status >= 400) {
      this.logger.warn(
        `${request.method} ${request.url} → ${status} | err=${JSON.stringify(
          message
        )} | userId=${userId} | body=${bodyStr}${technicalLogDetail ? ` | detail=${technicalLogDetail}` : ''}`
      );
    }

    const isObject = typeof message === 'object' && message !== null;
    const msgObj = isObject ? (message as Record<string, any>) : {};

    let finalMessage = msgObj.message ?? message;
    if (status === 403 && (finalMessage === 'Forbidden resource' || (typeof finalMessage === 'string' && finalMessage.includes('Forbidden resource')))) {
      const url = request.url || '';
      if (url.includes('/groups')) {
        finalMessage = 'Solo el encargado puede eliminar una empresa cliente';
      } else if (url.includes('/statements') && url.includes('/cancel')) {
        finalMessage = 'Solo el encargado puede anular un estado de cuenta';
      } else if (url.includes('/force-close')) {
        finalMessage = 'Solo el encargado puede forzar el cierre de turno de otro usuario';
      } else {
        finalMessage = 'Solo el encargado o administrador puede realizar esta acción';
      }
      if (isObject && msgObj.message) {
        msgObj.message = finalMessage;
      }
    }

    response.status(status).json({
      statusCode: status,
      ...msgObj,
      message: finalMessage,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}

