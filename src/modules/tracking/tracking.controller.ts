import { Controller, Get, Param } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly service: TrackingService) {}

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'tracking' };
  }

  @Get(':token')
  @Public()
  async getByToken(@Param('token') token: string) {
    return this.service.getByToken(token);
  }
}
