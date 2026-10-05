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

/**
 * Zona horaria estándar por defecto del negocio.
 * Preparada para parametrización por negocio en el futuro.
 */
export const DEFAULT_BUSINESS_TIMEZONE = 'America/Managua';

/**
 * Interpreta una fecha local ('YYYY-MM-DD') y una hora local ('HH:mm:ss.sss')
 * bajo una zona horaria específica y retorna el objeto Date en instante UTC exacto.
 */
export function parseLocalDateToUtc(
  dateStr: string,
  timeStr: string = '00:00:00.000',
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, min, secAndMs] = timeStr.split(':');
  const [sec, ms] = (secAndMs || '00.000').split('.').map(Number);

  // Instante UTC de referencia preliminar
  const utcApprox = new Date(
    Date.UTC(year, month - 1, day, Number(hour || 0), Number(min || 0), sec || 0, ms || 0),
  );

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcApprox);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const tzYear = Number(map.year);
  const tzMonth = Number(map.month);
  const tzDay = Number(map.day);
  let tzHour = Number(map.hour);
  if (tzHour === 24) tzHour = 0;
  const tzMin = Number(map.minute);
  const tzSec = Number(map.second);

  const tzAsUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin, tzSec, ms || 0);
  const offsetMs = tzAsUtc - utcApprox.getTime();

  return new Date(utcApprox.getTime() - offsetMs);
}

/**
 * Retorna el instante UTC exacto correspondiente a las 00:00:00.000 de la fecha local indicada.
 */
export function getStartOfDayInTimezone(
  dateInput: string | Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  if (!dateInput) return new Date(NaN);
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return parseLocalDateToUtc(trimmed, '00:00:00.000', timeZone);
    }
    if (trimmed.includes('T')) {
      if (trimmed.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
        return new Date(trimmed);
      }
      return parseLocalDateToUtc(trimmed.split('T')[0], '00:00:00.000', timeZone);
    }
  }
  if (dateInput instanceof Date) return dateInput;
  return new Date(NaN);
}

/**
 * Retorna el instante UTC exacto correspondiente a las 23:59:59.999 de la fecha local indicada.
 */
export function getEndOfDayInTimezone(
  dateInput: string | Date,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  if (!dateInput) return new Date(NaN);
  if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return parseLocalDateToUtc(trimmed, '23:59:59.999', timeZone);
    }
    if (trimmed.includes('T')) {
      if (trimmed.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
        return new Date(trimmed);
      }
      return parseLocalDateToUtc(trimmed.split('T')[0], '23:59:59.999', timeZone);
    }
  }
  if (dateInput instanceof Date) return dateInput;
  return new Date(NaN);
}

/**
 * Formatea una fecha a 'YYYY-MM-DD' en la zona horaria del negocio.
 */
export function formatDateInTimezone(
  date: string | Date | null | undefined,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (!d || isNaN(d.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(d);
}

/**
 * Retorna la cantidad de días de un mes (1 a 12) de forma determinista e independiente de la zona horaria local.
 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Agrega 'days' días a una fecha 'YYYY-MM-DD' y retorna la nueva fecha en 'YYYY-MM-DD'.
 */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().split('T')[0];
}

/**
 * Retorna [nextYear, nextMonth] dado un año y mes (1 a 12).
 */
export function getNextMonth(year: number, month: number): [number, number] {
  if (month === 12) return [year + 1, 1];
  return [year, month + 1];
}

/**
 * Formatea año, mes (1-12) y día a 'YYYY-MM-DD'.
 */
export function formatYearMonthDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
