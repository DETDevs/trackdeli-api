import { Controller, Post, Delete, Get, Patch, Body } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { Public } from '../../common/decorators/public.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('device-token')
  @Roles(UserRole.REPARTIDOR, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async registerToken(
    @Body() dto: { token: string; platform: 'android' | 'ios' },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.notificationsService.registerDeviceToken(user.sub, dto.token, dto.platform);
    return { message: 'Token registrado' };
  }

  @Delete('device-token')
  @Roles(UserRole.REPARTIDOR, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async removeToken(
    @Body() dto: { token: string },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.notificationsService.removeDeviceToken(dto.token);
    return { message: 'Token removido' };
  }

  @Get()
  @Roles(UserRole.REPARTIDOR, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getNotifications(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.getUserNotifications(user.sub);
  }

  @Patch('read')
  @Roles(UserRole.REPARTIDOR, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async markAsRead(
    @Body() dto: { notificationIds: string[] },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.notificationsService.markAsRead(user.sub, dto.notificationIds);
    return { message: 'Notificaciones marcadas como leídas' };
  }

  @Get('health')
  @Public()
  health() {
    return { status: 'ok', module: 'notifications' };
  }
}
