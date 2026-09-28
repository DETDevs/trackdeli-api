import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';

export interface SendWhatsAppOptions {
  to: string; // Número de teléfono destinatario
  text: string; // Mensaje de texto formateado
  templateName?: string;
  templateParams?: Record<string, string>;
  metadata?: Record<string, any>;
}

export interface SendWhatsAppResult {
  success: boolean;
  simulated: boolean;
  messageId?: string;
  error?: string;
}

@Injectable()
export class WhatsAppChannel {
  private readonly logger = new Logger(WhatsAppChannel.name);
  private readonly apiKey: string | null = null;
  private readonly phoneNumberId: string | null = null;
  private readonly apiUrl: string;

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>('WHATSAPP_BSP_API_KEY');
    const phoneId = this.configService.get<string>('WHATSAPP_BSP_PHONE_NUMBER_ID');

    this.apiKey = key && key.trim() !== '' ? key.trim() : null;
    this.phoneNumberId = phoneId && phoneId.trim() !== '' ? phoneId.trim() : null;
    this.apiUrl =
      this.configService.get<string>('WHATSAPP_BSP_API_URL') ||
      '';

    if (this.apiKey && this.phoneNumberId) {
      this.logger.log(
        `[WhatsAppChannel] WhatsApp BSP configurado en modo REAL (Phone ID: ${this.phoneNumberId}).`,
      );
    } else {
      this.logger.warn(
        '[WhatsAppChannel] Credenciales de WhatsApp BSP no configuradas. Los envíos se registrarán en modo SIMULADO.',
      );
    }
  }

  /**
   * Limpia y estandariza el número telefónico para WhatsApp (solo dígitos, con código de país si falta).
   */
  private cleanPhoneNumber(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    // Si tiene 8 dígitos (formato estándar de Nicaragua), anteponer 505
    if (digits.length === 8) {
      return `505${digits}`;
    }
    return digits;
  }

  /**
   * Envía un mensaje de WhatsApp a través del proveedor BSP o en modo simulado.
   */
  async send(options: SendWhatsAppOptions): Promise<SendWhatsAppResult> {
    const { to, text, templateName, templateParams, metadata } = options;
    const cleanTo = this.cleanPhoneNumber(to);

    // Modo simulado por defecto si no hay credenciales
    if (!this.apiKey || !this.phoneNumberId) {
      this.logger.log(
        `[WhatsAppChannel] (SIMULADO) WhatsApp a "${cleanTo}". Mensaje: "${text}"`,
      );
      Sentry.logger.info(`[WhatsAppChannel] (SIMULADO) WhatsApp enviado a "${cleanTo}"`, {
        to: cleanTo,
        text,
        templateName,
        metadata,
      });

      return {
        success: true,
        simulated: true,
      };
    }

    try {
      // Estructura de payload compatible con 360dialog y Meta WhatsApp Business Cloud API
      const payload: Record<string, any> = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanTo,
      };

      if (templateName) {
        payload.type = 'template';
        payload.template = {
          name: templateName,
          language: { code: 'es' },
          components: templateParams
            ? [
              {
                type: 'body',
                parameters: Object.entries(templateParams).map(([_, val]) => ({
                  type: 'text',
                  text: val,
                })),
              },
            ]
            : [],
        };
      } else {
        payload.type = 'text';
        payload.text = { body: text };
      }

      // Si la URL contiene placeholder de phoneNumberId, reemplazarlo
      const targetUrl = this.apiUrl.includes('{phoneNumberId}')
        ? this.apiUrl.replace('{phoneNumberId}', this.phoneNumberId)
        : this.apiUrl;

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'D360-API-KEY': this.apiKey, // Header 360dialog
          Authorization: `Bearer ${this.apiKey}`, // Header Meta Cloud API
        },
        body: JSON.stringify(payload),
      });

      const responseBody = await response.json().catch(() => null);

      if (!response.ok) {
        const errorMsg =
          responseBody?.error?.message ||
          responseBody?.message ||
          `HTTP ${response.status}: ${response.statusText}`;

        this.logger.error(
          `[WhatsAppChannel] ⚠ Error proveedor WhatsApp BSP enviando a "${cleanTo}": ${errorMsg}`,
        );
        Sentry.captureMessage(`[WhatsAppChannel] Error enviando WhatsApp: ${errorMsg}`, {
          level: 'error',
          extra: { to: cleanTo, text, metadata, responseBody },
        });

        return {
          success: false,
          simulated: false,
          error: errorMsg,
        };
      }

      const messageId =
        responseBody?.messages?.[0]?.id || responseBody?.id || undefined;

      this.logger.log(
        `[WhatsAppChannel] ✓ WhatsApp enviado exitosamente a "${cleanTo}". ID: ${messageId}`,
      );
      Sentry.logger.info(`[WhatsAppChannel] ✓ WhatsApp enviado a "${cleanTo}"`, {
        to: cleanTo,
        messageId,
        metadata,
      });

      return {
        success: true,
        simulated: false,
        messageId,
      };
    } catch (err: any) {
      this.logger.error(
        `[WhatsAppChannel] ⚠ Excepción enviando WhatsApp a "${cleanTo}": ${err.message}`,
        err.stack,
      );
      Sentry.captureException(err, {
        extra: {
          to: cleanTo,
          text,
          metadata,
        },
      });

      return {
        success: false,
        simulated: false,
        error: err.message || 'Error desconocido enviando WhatsApp',
      };
    }
  }
}
