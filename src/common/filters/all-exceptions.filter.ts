import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

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

    // Log detallado para 500s, warning para 4xx
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception)
      );
    } else if (status >= 400) {
      this.logger.warn(
        `${request.method} ${request.url} → ${status} | ${JSON.stringify(
          message
        )} | userId=${userId}`
      );
    }

    response.status(status).json({
      statusCode: status,
      message:
        typeof message === 'object' && 'message' in (message as object)
          ? (message as any).message
          : message,
      error:
        typeof message === 'object' && 'error' in (message as object)
          ? (message as any).error
          : undefined,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
