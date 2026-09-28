import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as Sentry from '@sentry/nestjs';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  metadata?: Record<string, any>;
}

export interface SendEmailResult {
  success: boolean;
  simulated: boolean;
  messageId?: string;
  error?: string;
}

@Injectable()
export class EmailChannel {
  private readonly logger = new Logger(EmailChannel.name);
  private readonly resend: Resend | null = null;
  private readonly fromEmail: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (apiKey && apiKey.trim() !== '') {
      this.resend = new Resend(apiKey.trim());
      this.logger.log('[EmailChannel] Resend inicializado correctamente con API Key.');
    } else {
      this.logger.warn(
        '[EmailChannel] RESEND_API_KEY no configurada. Los correos se registrarán en modo SIMULADO.',
      );
    }

    this.fromEmail =
      this.configService.get<string>('RESEND_FROM_EMAIL') ||
      'TrackDeli Notificaciones <notificaciones@trackdeli.com>';
  }

  /**
   * Envía un correo electrónico vía Resend o en modo simulado si no hay API Key configurada.
   */
  async send(options: SendEmailOptions): Promise<SendEmailResult> {
    const { to, subject, html, text, metadata } = options;

    if (!this.resend) {
      this.logger.log(
        `[EmailChannel] (SIMULADO) Email a "${to}". Asunto: "${subject}".`,
      );
      Sentry.logger.info(`[EmailChannel] (SIMULADO) Email enviado a "${to}"`, {
        to,
        subject,
        metadata,
      });
      return {
        success: true,
        simulated: true,
      };
    }

    try {
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to,
        subject,
        html,
        text,
      });

      if (response.error) {
        this.logger.error(
          `[EmailChannel] ⚠ Error proveedor Resend enviando a "${to}": ${response.error.message}`,
        );
        Sentry.captureMessage(`[EmailChannel] Resend API Error: ${response.error.message}`, {
          level: 'error',
          extra: { to, subject, metadata, error: response.error },
        });
        return {
          success: false,
          simulated: false,
          error: response.error.message,
        };
      }

      this.logger.log(
        `[EmailChannel] ✓ Correo enviado exitosamente a "${to}". ID: ${response.data?.id}`,
      );
      Sentry.logger.info(`[EmailChannel] ✓ Correo enviado a "${to}"`, {
        to,
        emailId: response.data?.id,
        subject,
        metadata,
      });

      return {
        success: true,
        simulated: false,
        messageId: response.data?.id,
      };
    } catch (err: any) {
      this.logger.error(
        `[EmailChannel] ⚠ Excepción enviando correo a "${to}": ${err.message}`,
        err.stack,
      );
      Sentry.captureException(err, {
        extra: {
          to,
          subject,
          metadata,
        },
      });

      return {
        success: false,
        simulated: false,
        error: err.message || 'Error desconocido enviando correo',
      };
    }
  }
}
