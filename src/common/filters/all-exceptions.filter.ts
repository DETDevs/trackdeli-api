import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  @SentryExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    const userId = request.user?.sub ?? 'anon';

    const bodyStr = request.body ? JSON.stringify(request.body) : '{}';
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} | body=${bodyStr} | userId=${userId}`,
        exception instanceof Error ? exception.stack : String(exception)
      );
    } else if (status >= 400) {
      this.logger.warn(
        `${request.method} ${request.url} → ${status} | err=${JSON.stringify(
          message
        )} | userId=${userId} | body=${bodyStr}`
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

