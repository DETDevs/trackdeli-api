import { Controller, Get } from '@nestjs/common';
import { TrackingService } from './tracking.service';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly service: TrackingService) {}

  @Get('health')
  healthCheck() {
    return { status: 'ok', module: 'tracking' };
  }
}

