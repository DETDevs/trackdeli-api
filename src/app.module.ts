import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MembershipGuard } from './common/guards/membership.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
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
  ],
  providers: [
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
