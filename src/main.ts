import './instrument';
import * as Sentry from '@sentry/nestjs';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TraceInterceptor } from './common/interceptors/trace.interceptor';
import { DecimalToNumberInterceptor } from './common/interceptors/decimal-to-number.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import compression = require('compression');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const configService = app.get(ConfigService);

  // Orígenes de producción autorizados (dominios nuevos nexolsoft.com y anteriores)
  const TRUSTED_PRODUCTION_ORIGINS = [
    // Dominios nuevos (nexolsoft.com)
    'https://www.nexolsoft.com',
    'https://nexolsoft.com',
    'https://pos.nexolsoft.com',
    'https://recibo.nexolsoft.com',
    'https://admin.nexolsoft.com',
    'https://super.nexolsoft.com',
    'https://citas.nexolsoft.com',
    'https://mesero.nexolsoft.com',
    // Dominios anteriores (deben seguir funcionando)
    'https://www.detdevs.com',
    'https://detdevs.com',
    'https://trackdeli-web-uwio.vercel.app',
    'https://trackdeli-web-tracking.vercel.app',
    'https://trackdeli-web-admin.vercel.app',
    'https://trackdeli-web-superadmin.vercel.app',
    'https://trackdeli-web-booking.vercel.app',
    'https://trackdeli-web-mesero.vercel.app',
  ];

  const corsOrigins = configService.get<string>('CORS_ORIGINS');
  const originsArray = corsOrigins
    ? corsOrigins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];

  // Agregar los orígenes de producción conocidos (nuevos y anteriores) sin duplicados
  for (const origin of TRUSTED_PRODUCTION_ORIGINS) {
    if (!originsArray.includes(origin)) {
      originsArray.push(origin);
    }
  }

  const frontendUrlKeys = [
    'TRACKING_URL',
    'RECEIPT_PUBLIC_URL',
    'BOOKING_APP_URL',
    'ADMIN_APP_URL',
    'SUPERADMIN_APP_URL',
    'MESERO_APP_URL',
    'POS_LANDING_URL',
  ];

  for (const key of frontendUrlKeys) {
    const val = configService.get<string>(key);
    if (val) {
      try {
        const urlOrigin = new URL(val).origin;
        if (!originsArray.includes(urlOrigin)) {
          originsArray.push(urlOrigin);
        }
      } catch {}
    }
  }

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

  app.use(compression({ threshold: 1024 }));
  app.useGlobalInterceptors(new TraceInterceptor(), new LoggingInterceptor(), new DecimalToNumberInterceptor());
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

