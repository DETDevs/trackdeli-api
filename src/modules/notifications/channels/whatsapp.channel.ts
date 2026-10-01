import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';

export interface SendWhatsAppOptions {
  to: string; // Número de teléfono destinatario
  text?: string; // Mensaje de texto (fallback o logs)
  templateName?: string;
  templateParams?: string[] | Record<string, string>;
  buttonSuffix?: string; // Sufijo dinámico del botón URL (index: 0)
  metadata?: Record<string, any>;
}

export interface SendWhatsAppTemplateOptions {
  to: string;
  templateName: 'location_confirmation_request' | 'appointment_confirmed';
  bodyParams: string[];
  buttonSuffix?: string;
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
  private readonly accessToken: string | null = null;
  private readonly phoneNumberId: string | null = null;
  private readonly apiVersion: string;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');
    const phoneId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const version = this.configService.get<string>('WHATSAPP_API_VERSION') || 'v21.0';

    this.accessToken = token && token.trim() !== '' ? token.trim() : null;
    this.phoneNumberId = phoneId && phoneId.trim() !== '' ? phoneId.trim() : null;
    this.apiVersion = version.trim().startsWith('v') ? version.trim() : `v${version.trim()}`;

    if (this.accessToken && this.phoneNumberId) {
      this.logger.log(
        `[WhatsAppChannel] Meta Cloud API configurada en modo REAL (Phone ID: ${this.phoneNumberId}, Versión: ${this.apiVersion}).`,
      );
    } else {
      this.logger.warn(
        '[WhatsAppChannel] Credenciales de Meta Cloud API no configuradas (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID). Los envíos se registrarán en modo SIMULADO.',
      );
    }
  }

  /**
   * Limpia y estandariza el número telefónico para Meta Cloud API (E.164 numérico sin '+').
   */
  cleanPhoneNumber(phone: string): string {
    let digits = phone.replace(/\D/g, '');
    // Quitar ceros iniciales si los hubiera (ej. 00505...)
    digits = digits.replace(/^00/, '');
    // Si tiene 8 dígitos (formato estándar de Nicaragua), anteponer 505
    if (digits.length === 8) {
      return `505${digits}`;
    }
    return digits;
  }

  /**
   * Formatea los errores devueltos por Meta Graph API en mensajes legibles y comprensibles.
   */
  private formatMetaError(responseBody: any, httpStatus: number): string {
    const error = responseBody?.error;
    if (!error) {
      return `Error HTTP ${httpStatus} en Meta Cloud API`;
    }

    const code = error.code;
    const subcode = error.error_subcode;
    const message = error.message || '';
    const details = error.error_data?.details || '';

    // Método de pago no configurado
    if (code === 131042) {
      return `Método de pago no configurado en la cuenta de WhatsApp Business (Meta code 131042): ${message}`;
    }

    // Plantilla no existe en el idioma o está pendiente de aprobación
    if (code === 132001 || subcode === 2494011) {
      return `Plantilla no aprobada o inexistente en Meta: ${details || message} (code ${code})`;
    }

    // Parámetros de plantilla incompatibles
    if (code === 132000 || subcode === 2494005) {
      return `Parámetros de plantilla incompatibles con la definición en Meta: ${details || message} (code ${code})`;
    }

    // Token inválido o expirado
    if (code === 190) {
      return `Token de acceso de Meta inválido o expirado (WHATSAPP_ACCESS_TOKEN): ${message} (code 190)`;
    }

    // ID de teléfono no válido o sin permisos
    if (code === 100) {
      return `Parámetro o Phone Number ID no válido en Meta (WHATSAPP_PHONE_NUMBER_ID): ${message} (code 100)`;
    }

    // Destinatario no válido / no tiene WhatsApp / no entregable
    if (code === 131026) {
      return `Número destinatario no registrado en WhatsApp o mensaje no entregable: ${details || message} (code 131026)`;
    }

    // Ventana de conversación de 24h expirada para mensajes tipo texto libre
    if (code === 131047) {
      return `Ventana de 24h cerrada. Se requiere una plantilla aprobada para iniciar conversación: ${message} (code 131047)`;
    }

    // Límite de tasa (Rate limit hit)
    if (code === 130429) {
      return `Límite de envíos excedido en Meta (Rate limit hit): ${message} (code 130429)`;
    }

    // Cuenta o número restringido / suspendido
    if (code === 131056 || code === 368) {
      return `Cuenta de WhatsApp Business o número restringido temporalmente por Meta: ${message} (code ${code})`;
    }

    // Fallback detallado
    return `Meta Cloud API (${code}${subcode ? '/' + subcode : ''}): ${message}${details ? ' - ' + details : ''}`;
  }

  /**
   * Envía una plantilla tipada de forma unificada.
   */
  async sendTemplate(options: SendWhatsAppTemplateOptions): Promise<SendWhatsAppResult> {
    return this.send({
      to: options.to,
      templateName: options.templateName,
      templateParams: options.bodyParams,
      buttonSuffix: options.buttonSuffix,
      metadata: options.metadata,
    });
  }

  /**
   * Envía un mensaje de WhatsApp directo a través de Meta Cloud API o en modo simulado.
   */
  async send(options: SendWhatsAppOptions): Promise<SendWhatsAppResult> {
    const { to, text, templateName, templateParams, buttonSuffix, metadata } = options;
    const cleanTo = this.cleanPhoneNumber(to);

    // Modo simulado por defecto si faltan credenciales
    if (!this.accessToken || !this.phoneNumberId) {
      this.logger.log(
        `[WhatsAppChannel] (SIMULADO) WhatsApp a "${cleanTo}". Template: "${templateName || 'none'}". ButtonSuffix: "${buttonSuffix || 'none'}". Mensaje: "${text || ''}"`,
      );
      Sentry.logger.info(`[WhatsAppChannel] (SIMULADO) WhatsApp enviado a "${cleanTo}"`, {
        to: cleanTo,
        text,
        templateName,
        templateParams,
        buttonSuffix,
        metadata,
      });

      return {
        success: true,
        simulated: true,
      };
    }

    try {
      let payload: Record<string, any>;

      if (templateName) {
        const components: any[] = [];

        if (templateParams) {
          const paramList = Array.isArray(templateParams)
            ? templateParams
            : Object.values(templateParams);

          if (paramList.length > 0) {
            components.push({
              type: 'body',
              parameters: paramList.map((val) => ({
                type: 'text',
                text: String(val ?? ''),
              })),
            });
          }
        }

        // Agregar componente button dinámico (index 0, sub_type url) si hay sufijo
        if (buttonSuffix && buttonSuffix.trim() !== '') {
          components.push({
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [
              {
                type: 'text',
                text: buttonSuffix.trim(),
              },
            ],
          });
        }

        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'template',
          template: {
            name: templateName,
            language: { code: 'es' },
            components,
          },
        };
      } else {
        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: cleanTo,
          type: 'text',
          text: { body: text || '' },
        };
      }

      const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const responseBody = await response.json().catch(() => null);

      if (!response.ok) {
        const errorMsg = this.formatMetaError(responseBody, response.status);

        this.logger.error(
          `[WhatsAppChannel] ⚠ Error Meta Cloud API enviando a "${cleanTo}": ${errorMsg}`,
        );
        Sentry.captureMessage(`[WhatsAppChannel] Meta Cloud API Error: ${errorMsg}`, {
          level: 'error',
          extra: { to: cleanTo, templateName, payload, responseBody },
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
        `[WhatsAppChannel] ✓ WhatsApp enviado exitosamente vía Meta Cloud API a "${cleanTo}". ID: ${messageId}`,
      );
      Sentry.logger.info(`[WhatsAppChannel] ✓ WhatsApp enviado vía Meta Cloud API a "${cleanTo}"`, {
        to: cleanTo,
        messageId,
        templateName,
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
          templateName,
          metadata,
        },
      });

      return {
        success: false,
        simulated: false,
        error: err.message || 'Error desconocido de conexión con Meta Cloud API',
      };
    }
  }
}
