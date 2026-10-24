import { Module, Logger, Provider } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bull';
import { isRedisEnabled } from '../../common/utils/redis.util';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { EmailChannel } from './channels/email.channel';
import { WhatsAppChannel } from './channels/whatsapp.channel';
import { NotificationTemplateRegistry } from './templates/notification-template.registry';
import { NotificationsProcessor } from './processors/notifications.processor';
import { NotificationExecutionService } from './services/notification-execution.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';

const isRedisOn = isRedisEnabled();
const isWorkersEnabled = process.env.ENABLE_QUEUE_WORKERS !== 'false';

const notificationProviders: Provider[] = [
  NotificationsService,
  FirebaseService,
  EmailChannel,
  WhatsAppChannel,
  NotificationTemplateRegistry,
  NotificationExecutionService,
];

const moduleImports: any[] = [
  PrismaModule,
  ConfigModule,
];

if (isRedisOn) {
  moduleImports.push(
    BullModule.registerQueue({
      name: 'notifications',
    }),
  );

  if (isWorkersEnabled) {
    notificationProviders.push(NotificationsProcessor);
    Logger.log('[NotificationsModule] Queue workers activados para procesar jobs de notificaciones.', 'NotificationsModule');
  } else {
    Logger.warn(
      '[NotificationsModule] ENABLE_QUEUE_WORKERS=false: Queue workers desactivados. Este proceso solo encolará notificaciones sin sondear Redis.',
      'NotificationsModule',
    );
  }
} else {
  // Provee null para el token de la cola Bull para que @InjectQueue('notifications') no falle
  notificationProviders.push({
    provide: getQueueToken('notifications'),
    useValue: null,
  });
  Logger.log(
    '[NotificationsModule] Redis deshabilitado. Notificaciones operando directamente en segundo plano sin colas Bull.',
    'NotificationsModule',
  );
}

@Module({
  imports: moduleImports,
  controllers: [NotificationsController],
  providers: notificationProviders,
  exports: [
    NotificationsService,
    FirebaseService,
    EmailChannel,
    WhatsAppChannel,
    NotificationTemplateRegistry,
    NotificationExecutionService,
  ],
})
export class NotificationsModule {}
