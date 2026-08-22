import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const configService = app.get(ConfigService);
  
  // CORS dynamic from env
  const corsOrigins = configService.get<string>('CORS_ORIGINS');
  const originsArray = corsOrigins ? corsOrigins.split(',') : [];
  
  app.enableCors({
    origin: originsArray.length > 0 ? originsArray : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  });

  // Prefix
  app.setGlobalPrefix('api/v1');

  // Global Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.use((req: any, res: any, next: any) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); next(); });
  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port);
  console.log(`Application is running on: await app.getUrl()`);
}
bootstrap();
