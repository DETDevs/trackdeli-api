import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { TrackingGateway } from './tracking.gateway';

@Module({
  controllers: [TrackingController],
  providers: [TrackingService, TrackingGateway],
})
export class TrackingModule {}

