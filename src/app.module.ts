import { Module, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { SentryModule } from '@sentry/nestjs/setup';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BusinessesModule } from './modules/businesses/businesses.module';
import { OrdersModule } from './modules/orders/orders.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { UploadModule } from './modules/upload/upload.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { SuperAdminModule } from './modules/superadmin/superadmin.module';
import { PosModule } from './modules/pos/pos.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { ClientsModule } from './modules/clients/clients.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { CommissionsModule } from './modules/commissions/commissions.module';
import { InviteCodesModule } from './modules/invite-codes/invite-codes.module';
import { CustomersModule } from './modules/customers/customers.module';
import { BusinessProductsModule } from './modules/business-products/business-products.module';
import { BookingModule } from './modules/booking/booking.module';
import { IndustriesModule } from './modules/industries/industries.module';
import { ClientVersionModule } from './modules/client-version/client-version.module';
import { ClientVersionGuard } from './modules/client-version/client-version.guard';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MembershipGuard } from './common/guards/membership.guard';
import { HealthController } from './health.controller';

import { CustomThrottlerGuard } from './common/guards/custom-throttler.guard';
import { WebAdminAccessGuard } from './common/guards/web-admin-access.guard';

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const logger = new Logger('BullModule');
        const redisOpts = {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
          tls: configService.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: (times: number) => {
            if (times > 50) return 30000;
            return Math.min(times * 1000, 30000);
          },
        };

        let sharedClient: any = null;
        let sharedSubscriber: any = null;

        const getOrCreateSharedClient = (type: 'client' | 'subscriber') => {
          if (type === 'client') {
            if (!sharedClient) {
              sharedClient = new Redis(redisOpts);
              sharedClient.on('error', (err: any) => {
                logger.warn(`[Bull client] Advertencia de conexión Redis: ${err.message}`);
              });
            }
            return sharedClient;
          }
          if (type === 'subscriber') {
            if (!sharedSubscriber) {
              sharedSubscriber = new Redis(redisOpts);
              sharedSubscriber.on('error', (err: any) => {
                logger.warn(`[Bull subscriber] Advertencia de conexión Redis: ${err.message}`);
              });
            }
            return sharedSubscriber;
          }
          return null;
        };

        const drainDelay = Number(configService.get<number>('BULL_DRAIN_DELAY', 30));
        const guardInterval = Number(configService.get<number>('BULL_GUARD_INTERVAL', 60000));
        const stalledInterval = Number(configService.get<number>('BULL_STALLED_INTERVAL', 60000));
        const lockDuration = Number(configService.get<number>('BULL_LOCK_DURATION', 60000));

        logger.log(
          `[BullModule] Configuración optimizada de colas: drainDelay=${drainDelay}s, guardInterval=${guardInterval}ms, stalledInterval=${stalledInterval}ms, lockDuration=${lockDuration}ms`,
        );

        return {
          redis: redisOpts,
          createClient: (type: string, opts: any) => {
            switch (type) {
              case 'client':
                return getOrCreateSharedClient('client');
              case 'subscriber':
                return getOrCreateSharedClient('subscriber');
              case 'bclient': {
                const bclient = new Redis({
                  ...opts,
                  maxRetriesPerRequest: null,
                  enableReadyCheck: false,
                  retryStrategy: (times: number) => {
                    if (times > 50) return 30000;
                    return Math.min(times * 1000, 30000);
                  },
                });
                bclient.on('error', (err: any) => {
                  logger.warn(`[Bull bclient] Advertencia de conexión Redis: ${err.message}`);
                });
                return bclient;
              }
              default: {
                const fallbackClient = new Redis(opts);
                fallbackClient.on('error', (err: any) => {
                  logger.warn(`[Bull ${type}] Advertencia de conexión Redis: ${err.message}`);
                });
                return fallbackClient;
              }
            }
          },
          settings: {
            lockDuration,
            stalledInterval,
            maxStalledCount: 1,
            guardInterval,
            retryProcessDelay: 10000,
            drainDelay,
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: true,
            removeOnFail: false,
          },
        };
      },
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 100,
      },
    ]),
    PrismaModule,
    AuthModule,
    UsersModule,
    BusinessesModule,
    OrdersModule,
    TrackingModule,
    NotificationsModule,
    UploadModule,
    RatingsModule,
    SuperAdminModule,
    PosModule,
    QuotesModule,
    ClientsModule,
    DispatchModule,
    CommissionsModule,
    InviteCodesModule,
    CustomersModule,
    BusinessProductsModule,
    BookingModule,
    IndustriesModule,
    ClientVersionModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ClientVersionGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: MembershipGuard,
    },
    {
      provide: APP_GUARD,
      useClass: WebAdminAccessGuard,
    },
  ],
})
export class AppModule {}
