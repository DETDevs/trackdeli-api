import './instrument';
import * as Sentry from '@sentry/nestjs';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const configService = app.get(ConfigService);

  const corsOrigins = configService.get<string>('CORS_ORIGINS');
  const originsArray = corsOrigins
    ? corsOrigins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];

  const isProduction = configService.get<string>('NODE_ENV') === 'production';
  if (isProduction && originsArray.length === 0) {
    throw new Error('CORS_ORIGINS debe contener orígenes válidos en producción.');
  }

  app.enableCors({
    origin: originsArray.length > 0 ? originsArray : (!isProduction),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());

  app.use((req: any, res: any, next: any) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); next(); });
  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port);
  Logger.log(`Application is running on: await app.getUrl()`, 'Bootstrap');
  Sentry.logger.info('TrackDeli API iniciada exitosamente', {
    port,
    environment: process.env.NODE_ENV || 'development',
  });
}
bootstrap();

