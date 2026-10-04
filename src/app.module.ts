import { Module } from '@nestjs/common';
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
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MembershipGuard } from './common/guards/membership.guard';
import { HealthController } from './health.controller';

import { CustomThrottlerGuard } from './common/guards/custom-throttler.guard';

@Module({
  imports: [
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
          tls: configService.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: (times: number) => {
            return Math.min(times * 500, 10000);
          },
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
      }),
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
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
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
  ],
})
export class AppModule {}
