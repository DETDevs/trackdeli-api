import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { EmailChannel } from './channels/email.channel';
import { WhatsAppChannel } from './channels/whatsapp.channel';
import { NotificationTemplateRegistry } from './templates/notification-template.registry';
import { NotificationsProcessor } from './processors/notifications.processor';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    BullModule.registerQueue({
      name: 'notifications',
    }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    FirebaseService,
    EmailChannel,
    WhatsAppChannel,
    NotificationTemplateRegistry,
    NotificationsProcessor,
  ],
  exports: [
    NotificationsService,
    FirebaseService,
    EmailChannel,
    WhatsAppChannel,
    NotificationTemplateRegistry,
  ],
})
export class NotificationsModule {}
