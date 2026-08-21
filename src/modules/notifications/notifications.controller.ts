import { Controller, Get } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Public } from '../../common/decorators/public.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'notifications' };
  }
}

