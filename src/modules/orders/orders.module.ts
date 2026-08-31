import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { TrackingModule } from '../tracking/tracking.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { CommissionsModule } from '../commissions/commissions.module';

@Module({
  imports: [
    PrismaModule,
    UploadModule,
    TrackingModule,
    NotificationsModule,
    DispatchModule,
    CommissionsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
