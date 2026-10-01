import { Controller, Post, Delete, Get, Patch, Body } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { Public } from '../../common/decorators/public.decorator';

import { WhatsAppChannel } from './channels/whatsapp.channel';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly whatsappChannel: WhatsAppChannel,
  ) {}

  @Get('diagnostic')
  @Public()
  async getDiagnostic() {
    const config = this.whatsappChannel.getConfigInfo();
    const lastLogs = await this.notificationsService.getNotificationLogs({ take: 10 });
    return {
      status: 'ok',
      whatsappConfig: config,
      recentLogs: lastLogs.map((l) => ({
        id: l.id,
        channel: l.channel,
        event: l.event,
        recipient: l.recipientContact,
        status: l.status,
        errorMessage: l.errorMessage,
        wamid: (l.metadata as any)?.wamid || null,
        metadata: l.metadata,
        createdAt: l.createdAt,
        sentAt: l.sentAt,
      })),
    };
  }

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

  @Post('test')
  @Roles(UserRole.REPARTIDOR, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async sendTestPush(@CurrentUser() user: JwtPayload) {
    return this.notificationsService.sendTestPush(user.sub);
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
