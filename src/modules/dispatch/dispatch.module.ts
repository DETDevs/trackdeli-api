import { Module } from '@nestjs/common';
import { DispatchService } from './dispatch.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TrackingModule } from '../tracking/tracking.module';

@Module({
  imports: [PrismaModule, NotificationsModule, TrackingModule],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
