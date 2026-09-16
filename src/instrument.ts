import 'dotenv/config';
import * as Sentry from '@sentry/nestjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  // Filtra eventos antes de enviarlos: no reportar como "error" los rechazos
  // esperados del negocio (400/403/404 lanzados a propósito por validaciones,
  // ej. caja cerrada, stock insuficiente, rol sin permiso). Sentry debe capturar
  // solo lo verdaderamente inesperado.
  beforeSend(event, hint) {
    const exception = hint?.originalException;
    if (
      exception &&
      typeof exception === 'object' &&
      'getStatus' in exception &&
      typeof (exception as any).getStatus === 'function'
    ) {
      const status = (exception as any).getStatus();
      if (status >= 400 && status < 500) {
        return null; // no enviar a Sentry — es un rechazo de negocio esperado
      }
    }
    return event;
  },
});
