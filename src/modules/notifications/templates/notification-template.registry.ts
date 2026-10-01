import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import {
  formatAppointmentDate,
  sanitizeMetaParam,
} from '../../../common/utils/date.util';

export interface NotificationVariables {
  customerName?: string;
  businessName?: string;
  concept?: string;
  serviceName?: string;
  scheduledAt?: Date | string;
  durationMinutes?: number;
  price?: number;
  currency?: string;
  address?: string | null;
  manageToken?: string;
  manageUrl?: string;
  confirmationUrl?: string;
  url?: string;
  shortCode?: string;
  orderSummary?: string;
  status?: string;
  dateFormatted?: string;
  [key: string]: any;
}

export interface RenderedTemplate {
  subject?: string;
  html?: string;
  text: string;
  templateName?: string;
  templateParams?: string[];
  buttonSuffix?: string;
}

@Injectable()
export class NotificationTemplateRegistry {
  /**
   * Formatea una fecha para visualización en Managua/Nicaragua si no viene pre-formateada.
   */
  private formatDate(date?: Date | string): string {
    if (!date) return '';
    try {
      const d = typeof date === 'string' ? new Date(date) : date;
      return new Intl.DateTimeFormat('es-NI', {
        timeZone: 'America/Managua',
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(d);
    } catch {
      return String(date);
    }
  }

  /**
   * Genera el HTML base para correos transaccionales de Citas.
   */
  private renderBookingHtml(params: {
    title: string;
    badgeHtml: string;
    businessName: string;
    serviceName: string;
    dateFormatted: string;
    durationMinutes?: number;
    price?: number;
    currencySymbol: string;
    address?: string | null;
    manageUrl?: string;
  }): string {
    const {
      title,
      badgeHtml,
      businessName,
      serviceName,
      dateFormatted,
      durationMinutes,
      price,
      currencySymbol,
      address,
      manageUrl,
    } = params;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3f4f6; margin: 0; padding: 24px;">
  <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #e5e7eb;">
    <div style="background-color: #111827; padding: 20px 24px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700;">${businessName}</h1>
      <p style="color: #9ca3af; margin: 4px 0 0 0; font-size: 14px;">Reserva de Cita</p>
    </div>

    <div style="padding: 24px;">
      <div style="text-align: center; margin-bottom: 20px;">
        ${badgeHtml}
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
          ${
            durationMinutes
              ? `<tr>
            <td style="padding: 8px 0; color: #6b7280;">Duración:</td>
            <td style="padding: 8px 0; font-weight: 600; text-align: right; color: #111827;">${durationMinutes} minutos</td>
          </tr>`
              : ''
          }
          ${
            price !== undefined && price !== null
              ? `<tr>
            <td style="padding: 8px 0; color: #6b7280;">Precio:</td>
            <td style="padding: 8px 0; font-weight: 700; text-align: right; color: #059669; font-size: 16px;">${currencySymbol}${Number(price).toFixed(2)}</td>
          </tr>`
              : ''
          }
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

      ${
        manageUrl
          ? `<div style="text-align: center; margin-bottom: 24px;">
        <p style="color: #4b5563; font-size: 14px; margin-bottom: 16px;">
          Podés ver el estado de tu cita, cancelarla o reagendarla desde el siguiente enlace:
        </p>
        <a href="${manageUrl}" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Gestionar mi Cita</a>
      </div>`
          : ''
      }

      <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; text-align: center; color: #9ca3af; font-size: 12px;">
        <p style="margin: 0;">Si tenés dudas o necesitás asistencia urgente, contactá al negocio directamente.</p>
        ${manageUrl ? `<p style="margin: 4px 0 0 0;">Enlace de autogestión: <a href="${manageUrl}" style="color: #2563eb;">${manageUrl}</a></p>` : ''}
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Renderiza el contenido según evento, canal y variables suministradas.
   */
  render(
    event: string,
    channel: NotificationChannel,
    vars: NotificationVariables,
  ): RenderedTemplate {
    const customerName = vars.customerName || 'Estimado/a cliente';
    const businessName = vars.businessName || 'TrackDeli';
    const serviceName = vars.serviceName || vars.concept || 'Servicio';
    const dateFormatted = vars.dateFormatted || this.formatDate(vars.scheduledAt);
    const currency = vars.currency || 'NIO';
    const currencySymbol = currency === 'USD' || currency === '$' ? '$' : 'C$';
    const manageUrl = vars.manageUrl || '';

    switch (event) {
      case 'APPOINTMENT_CONFIRMED': {
        const clientName = sanitizeMetaParam(vars.customerName, 'cliente');
        const bizName = sanitizeMetaParam(vars.businessName, 'el negocio');
        const aptDate = vars.scheduledAt
          ? formatAppointmentDate(vars.scheduledAt)
          : (vars.dateFormatted || '').replace(/\.+$/, '');
        const services = sanitizeMetaParam(
          vars.serviceName || vars.concept,
          'tu cita',
        );
        const buttonSuffix = (vars.manageToken || vars.token || '').trim();

        if (channel === NotificationChannel.WHATSAPP) {
          const text =
            `¡Hola ${clientName}!\n\n` +
            `Tu cita en ${bizName} 📅\n` +
            `quedó confirmada: para el ${aptDate}.\n\n` +
            `Servicio(s): ${services}.\n\n` +
            `Si necesitás reagendar o cancelar, contactanos.` +
            (manageUrl ? `\n\nGestionar mi cita: ${manageUrl}` : '');

          return {
            text,
            templateName: 'appointment_confirmed',
            templateParams: [clientName, bizName, aptDate, services],
            buttonSuffix: buttonSuffix || undefined,
          };
        } else {
          const subject = `¡Cita Confirmada! — ${serviceName} en ${businessName}`;
          const badgeHtml =
            '<span style="display:inline-block;padding:4px 12px;background:#d1fae5;color:#065f46;border-radius:12px;font-weight:600;font-size:13px;">Confirmada</span>';
          const html = this.renderBookingHtml({
            title: subject,
            badgeHtml,
            businessName,
            serviceName,
            dateFormatted: aptDate || dateFormatted,
            durationMinutes: vars.durationMinutes,
            price: vars.price,
            currencySymbol,
            address: vars.address,
            manageUrl,
          });
          const text = `¡Hola ${customerName}! Te confirmamos tu cita para ${serviceName} el ${aptDate || dateFormatted} en ${businessName}.`;
          return { subject, html, text };
        }
      }

      case 'APPOINTMENT_RECEIPT': {
        if (channel === NotificationChannel.WHATSAPP) {
          const text = `¡Hola ${customerName}! Recibimos tu reserva para *${serviceName}* el *${dateFormatted}* en *${businessName}*. Te notificaremos cuando sea confirmada. Podés ver los detalles aquí: ${manageUrl}`;
          return {
            text,
            templateName: 'appointment_receipt',
            templateParams: [customerName, serviceName, dateFormatted, businessName, manageUrl],
          };
        } else {
          const subject = `Comprobante de Reserva — ${serviceName} en ${businessName}`;
          const badgeHtml =
            '<span style="display:inline-block;padding:4px 12px;background:#fef3c7;color:#92400e;border-radius:12px;font-weight:600;font-size:13px;">Pendiente de Aprobación</span>';
          const html = this.renderBookingHtml({
            title: subject,
            badgeHtml,
            businessName,
            serviceName,
            dateFormatted,
            durationMinutes: vars.durationMinutes,
            price: vars.price,
            currencySymbol,
            address: vars.address,
            manageUrl,
          });
          const text = `¡Hola ${customerName}! Recibimos tu comprobante de reserva para ${serviceName} el ${dateFormatted} en ${businessName}.`;
          return { subject, html, text };
        }
      }

      case 'APPOINTMENT_RESCHEDULED': {
        if (channel === NotificationChannel.WHATSAPP) {
          const text = `¡Hola ${customerName}! Tu cita para *${serviceName}* en *${businessName}* fue reagendada para el *${dateFormatted}*. Podés gestionarla aquí: ${manageUrl}`;
          return {
            text,
            templateName: 'appointment_rescheduled',
            templateParams: [customerName, serviceName, businessName, dateFormatted, manageUrl],
          };
        } else {
          const subject = `Cita Reagendada — ${serviceName} en ${businessName}`;
          const badgeHtml =
            '<span style="display:inline-block;padding:4px 12px;background:#fef3c7;color:#92400e;border-radius:12px;font-weight:600;font-size:13px;">Pendiente de Aprobación</span>';
          const html = this.renderBookingHtml({
            title: subject,
            badgeHtml,
            businessName,
            serviceName,
            dateFormatted,
            durationMinutes: vars.durationMinutes,
            price: vars.price,
            currencySymbol,
            address: vars.address,
            manageUrl,
          });
          const text = `¡Hola ${customerName}! Tu cita para ${serviceName} en ${businessName} fue reagendada para el ${dateFormatted}.`;
          return { subject, html, text };
        }
      }

      case 'LOCATION_CONFIRMATION_REQUEST': {
        const confirmUrl = vars.confirmationUrl || vars.url || '';
        const clientName = sanitizeMetaParam(vars.customerName, 'cliente');
        const orderSummary = sanitizeMetaParam(
          vars.orderSummary || vars.concept || vars.businessName,
          'tu pedido',
        );
        const buttonSuffix = (vars.shortCode || vars.token || '').trim();

        if (channel === NotificationChannel.WHATSAPP) {
          const text =
            `¡Hola ${clientName}! 📍\n\n` +
            `Para coordinar la entrega de tu pedido de ${orderSummary},\n` +
            `necesitamos que confirmes tu ubicación exacta.\n\n` +
            `¡Gracias! 🙌` +
            (confirmUrl ? `\n\n${confirmUrl}` : '');

          return {
            text,
            templateName: 'location_confirmation_request',
            templateParams: [clientName, orderSummary],
            buttonSuffix: buttonSuffix || undefined,
          };
        } else {
          const subject = `Confirmá tu ubicación de entrega — ${businessName}`;
          const text = `¡Hola ${clientName}! Para coordinar la entrega de tu pedido con ${businessName}, por favor confirmá tu ubicación exacta en el siguiente enlace: ${confirmUrl}`;
          const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6; margin: 0; padding: 24px;">
  <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb;">
    <div style="background-color: #111827; padding: 20px 24px; text-align: center;">
      <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700;">${businessName}</h1>
      <p style="color: #9ca3af; margin: 4px 0 0 0; font-size: 14px;">Confirmación de Ubicación</p>
    </div>
    <div style="padding: 24px;">
      <p style="color: #111827; font-size: 15px; margin-top: 0;">¡Hola <strong>${clientName}</strong>!</p>
      <p style="color: #4b5563; font-size: 14px; line-height: 1.5;">
        Para coordinar la entrega de tu pedido con <strong>${businessName}</strong>, por favor confirmá tu ubicación exacta en el siguiente enlace:
      </p>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${confirmUrl}" style="display: inline-block; background-color: #10b981; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Confirmar mi Ubicación</a>
      </div>
      <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; text-align: center; color: #9ca3af; font-size: 12px;">
        <p style="margin: 0;">Enlace directo: <a href="${confirmUrl}" style="color: #2563eb;">${confirmUrl}</a></p>
      </div>
    </div>
  </div>
</body>
</html>`.trim();
          return { subject, html, text };
        }
      }

      default: {
        const text = `Notificación de ${businessName}: ${serviceName} (${dateFormatted})`;
        const subject = `Notificación de ${businessName}`;
        const html = `<p>${text}</p>`;
        return { subject, html, text };
      }
    }
  }
}
