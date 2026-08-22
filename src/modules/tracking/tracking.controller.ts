import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get('health')
  @Public()
  health() {
    return { status: 'ok', module: 'tracking' };
  }

  @Get(':token')
  @Public()
  async getByToken(@Param('token') token: string) {
    const data = await this.trackingService.getTrackingDataByToken(token);
    if (!data) {
      throw new NotFoundException('Link de tracking no válido o expirado');
    }
    return data;
  }
}
