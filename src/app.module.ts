import { Module, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { SentryModule } from '@sentry/nestjs/setup';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, Reflector } from '@nestjs/core';
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

import { isRedisEnabled, attachSafeRedisErrorHandler, getOptimizedRedisOptions } from './common/utils/redis.util';

const isRedisOn = isRedisEnabled();

const appImports: any[] = [
  SentryModule.forRoot(),
  ConfigModule.forRoot({
    isGlobal: true,
    validationSchema: envValidationSchema,
  }),
];

if (isRedisOn) {
  appImports.push(
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const logger = new Logger('BullModule');
        const redisConf = getOptimizedRedisOptions(configService);

        let sharedClient: any = null;
        let sharedSubscriber: any = null;

        const getOrCreateSharedClient = (type: 'client' | 'subscriber') => {
          if (type === 'client') {
            if (!sharedClient) {
              sharedClient = redisConf.url
                ? new Redis(redisConf.url, redisConf.options)
                : new Redis(redisConf.options);
              attachSafeRedisErrorHandler(sharedClient, 'Bull client', logger);
            }
            return sharedClient;
          }
          if (type === 'subscriber') {
            if (!sharedSubscriber) {
              sharedSubscriber = redisConf.url
                ? new Redis(redisConf.url, redisConf.options)
                : new Redis(redisConf.options);
              attachSafeRedisErrorHandler(sharedSubscriber, 'Bull subscriber', logger);
            }
            return sharedSubscriber;
          }
          return null;
        };

        const drainDelay = Number(configService.get<number>('BULL_DRAIN_DELAY', 60));
        const guardInterval = Number(configService.get<number>('BULL_GUARD_INTERVAL', 300000));
        const stalledInterval = Number(configService.get<number>('BULL_STALLED_INTERVAL', 300000));
        const lockDuration = Number(configService.get<number>('BULL_LOCK_DURATION', 60000));

        logger.log(
          `[BullModule] Configuración optimizada de colas: drainDelay=${drainDelay}s, guardInterval=${guardInterval}ms, stalledInterval=${stalledInterval}ms, lockDuration=${lockDuration}ms`,
        );

        return {
          redis: redisConf.options,
          createClient: (type: string, opts: any) => {
            switch (type) {
              case 'client':
                return getOrCreateSharedClient('client');
              case 'subscriber':
                return getOrCreateSharedClient('subscriber');
              case 'bclient': {
                const bclientOpts = {
                  ...(redisConf.options || {}),
                  ...(opts || {}),
                  maxRetriesPerRequest: null,
                };
                const bclient = redisConf.url
                  ? new Redis(redisConf.url, bclientOpts)
                  : new Redis(bclientOpts);
                attachSafeRedisErrorHandler(bclient, 'Bull bclient', logger);
                return bclient;
              }
              default: {
                const fallbackOpts = {
                  ...(redisConf.options || {}),
                  ...(opts || {}),
                };
                const fallbackClient = redisConf.url
                  ? new Redis(redisConf.url, fallbackOpts)
                  : new Redis(fallbackOpts);
                attachSafeRedisErrorHandler(fallbackClient, `Bull ${type}`, logger);
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
  );
} else {
  Logger.log(
    '[AppModule] Redis deshabilitado (REDIS_ENABLED=false o sin REDIS_URL). Operando en modo directo/memoria sin colas Bull.',
    'AppModule',
  );
}

@Module({
  imports: [
    ...appImports,
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
    Reflector,
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
