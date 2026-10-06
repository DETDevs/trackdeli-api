import { Process, Processor } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailChannel } from '../channels/email.channel';
import { WhatsAppChannel } from '../channels/whatsapp.channel';
import { NotificationTemplateRegistry } from '../templates/notification-template.registry';
import { NotificationExecutionService } from '../services/notification-execution.service';

export interface NotificationJobData {
  logId: string;
}

@Injectable()
@Processor('notifications')
export class NotificationsProcessor extends NotificationExecutionService {
  private readonly processorLogger = new Logger(NotificationsProcessor.name);

  constructor(
    prisma: PrismaService,
    emailChannel: EmailChannel,
    whatsappChannel: WhatsAppChannel,
    templateRegistry: NotificationTemplateRegistry,
  ) {
    super(prisma, emailChannel, whatsappChannel, templateRegistry);
  }

  @Process('send')
  async handleSendJob(job: Job<NotificationJobData>) {
    const { logId } = job.data;
    this.processorLogger.log(`[NotificationsProcessor] Procesando job Bull #${job.id} para logId: ${logId}`);
    await this.processNotification(logId, true);
  }
}
