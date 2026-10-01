/**
 * Utilidades para formateo de fechas y sanitización de parámetros para Meta Cloud API.
 */

/**
 * Formatea una fecha y hora en español (es-NI) bajo la zona horaria de Nicaragua (America/Managua),
 * garantizando que la hora no contenga puntos finales abreviados (ej. "29 sept 2026, 1:00 PM").
 * Esto evita el bug visual de "p.m.." con la plantilla aprobada de Meta.
 */
export function formatAppointmentDate(date: Date | string): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return String(date);

  // Parte de fecha: "29 sept 2026"
  const datePart = new Intl.DateTimeFormat('es-NI', {
    timeZone: 'America/Managua',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
    .format(d)
    .replace(/\./g, '')
    .trim();

  // Parte de hora: "1:00 PM"
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Managua',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(d)
    .trim();

  return `${datePart}, ${timePart}`;
}

/**
 * Sanitiza parámetros para Meta WhatsApp Cloud API según sus restricciones estrictas:
 * - Sin saltos de línea (\r, \n) ni tabulaciones (\t)
 * - Sin más de 4 espacios seguidos (colapsa múltiples espacios a uno solo)
 * - No vacío (utiliza fallback si viene vacío o tras limpiar queda vacío)
 * - Longitud máxima (~60 caracteres por defecto) recortada con elipsis ("…")
 */
export function sanitizeMetaParam(
  value: string | undefined | null,
  fallback: string,
  maxLength: number = 60,
): string {
  if (!value) return fallback;
  let sanitized = String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!sanitized) return fallback;

  if (sanitized.length > maxLength) {
    return sanitized.slice(0, maxLength - 1).trim() + '…';
  }

  return sanitized;
}
