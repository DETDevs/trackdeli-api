import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as Sentry from '@sentry/nestjs';

export interface BookingReceiptData {
  to: string;
  businessName: string;
  serviceName: string;
  scheduledAt: Date;
  durationMinutes: number;
  price: number;
  currency?: string;
  address?: string | null;
  manageToken: string;
  status: string; // 'PENDING' | 'CONFIRMED'
}

@Injectable()
export class BookingEmailService {
  private readonly logger = new Logger(BookingEmailService.name);
  private readonly resend: Resend | null = null;
  private readonly fromEmail: string;
  private readonly appUrl: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('[BookingEmailService] Resend inicializado correctamente con API Key.');
    } else {
      this.logger.warn(
        '[BookingEmailService] RESEND_API_KEY no configurada. Los correos se simularán en logs.',
      );
    }

    this.fromEmail =
      this.configService.get<string>('RESEND_FROM_EMAIL') ||
      'TrackDeli Citas <onboarding@resend.dev>';
    this.appUrl =
      this.configService.get<string>('BOOKING_APP_URL') ||
      'http://localhost:5173';
  }

  async sendBookingReceipt(data: BookingReceiptData): Promise<boolean> {
    const {
      to,
      businessName,
      serviceName,
      scheduledAt,
      durationMinutes,
      price,
      currency = 'NIO',
      address,
      manageToken,
      status,
    } = data;

    const currencySymbol = currency === 'USD' || currency === '$' ? '$' : 'C$';
    const manageUrl = `${this.appUrl.replace(/\/$/, '')}/manage/${manageToken}`;
    const dateFormatted = new Intl.DateTimeFormat('es-NI', {
      timeZone: 'America/Managua',
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date(scheduledAt));

    const statusBadge =
      status === 'CONFIRMED'
        ? '<span style="display:inline-block;padding:4px 12px;background:#d1fae5;color:#065f46;border-radius:12px;font-weight:600;font-size:13px;">Confirmada</span>'
        : '<span style="display:inline-block;padding:4px 12px;background:#fef3c7;color:#92400e;border-radius:12px;font-weight:600;font-size:13px;">Pendiente de Aprobación</span>';

    const subject =
      status === 'CONFIRMED'
        ? `¡Cita Confirmada! — ${serviceName} en ${businessName}`
        : `Comprobante de Reserva — ${serviceName} en ${businessName}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; margin: 0; padding: 24px;">
  <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #e5e7eb;">
    <div style="background-color: #111827; padding: 20px 24px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700;">${businessName}</h1>
      <p style="color: #9ca3af; margin: 4px 0 0 0; font-size: 14px;">Reserva de Cita</p>
    </div>

    <div style="padding: 24px;">
      <div style="text-align: center; margin-bottom: 20px;">
        ${statusBadge}
      </div>

      <div style="background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; padding: 16px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">Servicio:</td>
            <td style="padding: 8px 0; font-weight: 600; text-align: right; color: #111827;">${serviceName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">Fecha y Hora:</td>
            <td style="padding: 8px 0; font-weight: 600; text-align: right; color: #111827;">${dateFormatted}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">Duración:</td>
            <td style="padding: 8px 0; font-weight: 600; text-align: right; color: #111827;">${durationMinutes} minutos</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6b7280;">Precio:</td>
            <td style="padding: 8px 0; font-weight: 700; text-align: right; color: #059669; font-size: 16px;">${currencySymbol}${Number(price).toFixed(2)}</td>
          </tr>
          ${
            address
              ? `<tr>
            <td style="padding: 8px 0; color: #6b7280;">Dirección:</td>
            <td style="padding: 8px 0; text-align: right; color: #111827;">${address}</td>
          </tr>`
              : ''
          }
        </table>
      </div>

      <div style="text-align: center; margin-bottom: 24px;">
        <p style="color: #4b5563; font-size: 14px; margin-bottom: 16px;">
          Podés ver el estado de tu cita, cancelarla o reagendarla desde el siguiente enlace:
        </p>
        <a href="${manageUrl}" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Gestionar mi Cita</a>
      </div>

      <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; text-align: center; color: #9ca3af; font-size: 12px;">
        <p style="margin: 0;">Si tenés dudas o necesitás asistencia urgente, contactá al negocio directamente por WhatsApp.</p>
        <p style="margin: 4px 0 0 0;">Enlace de autogestión: <a href="${manageUrl}" style="color: #2563eb;">${manageUrl}</a></p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();

    if (!this.resend) {
      this.logger.log(
        `[BookingEmailService] (Simulación) Email enviado a "${to}". Asunto: "${subject}". ManageUrl: ${manageUrl}`,
      );
      Sentry.logger.info(`[BookingEmailService] (Simulación) Email enviado a "${to}"`, {
        to,
        businessName,
        serviceName,
        status,
        manageToken,
      });
      return true;
    }

    try {
      const response = await this.resend.emails.send({
        from: this.fromEmail,
        to,
        subject,
        html,
      });

      this.logger.log(
        `[BookingEmailService] ✓ Correo enviado exitosamente a "${to}". ID: ${response.data?.id}`,
      );
      Sentry.logger.info(`[BookingEmailService] ✓ Correo enviado a "${to}"`, {
        to,
        emailId: response.data?.id,
        businessName,
        serviceName,
        status,
        manageToken,
      });
      return true;
    } catch (err: any) {
      this.logger.error(
        `[BookingEmailService] ⚠ Error enviando correo a "${to}": ${err.message}`,
        err.stack,
      );
      Sentry.captureException(err, {
        extra: {
          to,
          businessName,
          serviceName,
          status,
          manageToken,
        },
      });
      return false;
    }
  }
}
