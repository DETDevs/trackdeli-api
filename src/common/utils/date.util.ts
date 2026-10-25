import { BadRequestException } from '@nestjs/common';

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

/**
 * Obtiene la hora (0-23) de una fecha según la zona horaria indicada.
 */
export function getHourInTimezone(date: Date | string, timeZone: string = DEFAULT_BUSINESS_TIMEZONE): number {
  if (!date) return 0;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return 0;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const hourPart = parts.find((p) => p.type === 'hour');
  const val = Number(hourPart?.value ?? 0);
  return val === 24 ? 0 : val;
}

export interface BusinessPeriodDates {
  startDate: Date;
  endDate: Date;
  fromIso: string;
  toIso: string;
  prismaWhere: { gte: Date; lte: Date };
}

export interface BusinessDateRangeResult extends BusinessPeriodDates {
  previous?: BusinessPeriodDates;
}

export interface ResolveBusinessDateRangeOptions {
  period?: string | null;
  from?: string | null;
  to?: string | null;
  timezone?: string | null;
  now?: Date;
}

/**
 * Helper unificado para resolver rangos de fechas bajo la zona horaria del negocio (por defecto 'America/Managua').
 * Garantiza límites exactos [inicio, fin] en instantes UTC para que las ventas nocturnas nunca queden fuera.
 */
export function resolveBusinessDateRange(
  options: ResolveBusinessDateRangeOptions = {},
): BusinessDateRangeResult {
  const tz = options.timezone || DEFAULT_BUSINESS_TIMEZONE;
  const now = options.now || new Date();
  const todayStr = formatDateInTimezone(now, tz);

  let curFrom: Date;
  let curTo: Date;
  let prevFrom: Date | undefined;
  let prevTo: Date | undefined;

  const cleanFrom = options.from?.trim();
  const cleanTo = options.to?.trim();

  if (cleanFrom || cleanTo) {
    const effectiveFrom = cleanFrom || cleanTo!;
    const effectiveTo = cleanTo || cleanFrom!;

    curFrom = getStartOfDayInTimezone(effectiveFrom, tz);
    curTo = getEndOfDayInTimezone(effectiveTo, tz);

    if (isNaN(curFrom.getTime()) || isNaN(curTo.getTime())) {
      throw new BadRequestException('Formato de fecha inválido');
    }

    if (curFrom > curTo) {
      throw new BadRequestException('La fecha inicial (from) no puede ser posterior a la fecha final (to)');
    }

    const diffMs = curTo.getTime() - curFrom.getTime();
    if (diffMs > 366 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('El rango de fechas no puede exceder 366 días');
    }

    prevTo = new Date(curFrom.getTime() - 1);
    prevFrom = new Date(prevTo.getTime() - diffMs);
  } else if (options.period === 'yesterday') {
    const yesterdayStr = addDaysToDateStr(todayStr, -1);
    curFrom = parseLocalDateToUtc(yesterdayStr, '00:00:00.000', tz);
    curTo = parseLocalDateToUtc(yesterdayStr, '23:59:59.999', tz);
    const dayBeforeStr = addDaysToDateStr(todayStr, -2);
    prevFrom = parseLocalDateToUtc(dayBeforeStr, '00:00:00.000', tz);
    prevTo = parseLocalDateToUtc(dayBeforeStr, '23:59:59.999', tz);
  } else if (options.period === 'last7days') {
    const startStr = addDaysToDateStr(todayStr, -6);
    curFrom = parseLocalDateToUtc(startStr, '00:00:00.000', tz);
    curTo = parseLocalDateToUtc(todayStr, '23:59:59.999', tz);
    const prevStartStr = addDaysToDateStr(todayStr, -13);
    const prevEndStr = addDaysToDateStr(todayStr, -7);
    prevFrom = parseLocalDateToUtc(prevStartStr, '00:00:00.000', tz);
    prevTo = parseLocalDateToUtc(prevEndStr, '23:59:59.999', tz);
  } else if (options.period === 'week') {
    // Lunes a hoy en la zona local vs mismos días de la semana anterior
    const [y, m, d] = todayStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dayOfWeek = dt.getUTCDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const mondayStr = addDaysToDateStr(todayStr, -daysSinceMonday);
    curFrom = parseLocalDateToUtc(mondayStr, '00:00:00.000', tz);
    curTo = parseLocalDateToUtc(todayStr, '23:59:59.999', tz);
    const prevMondayStr = addDaysToDateStr(mondayStr, -7);
    const prevEndStr = addDaysToDateStr(todayStr, -7);
    prevFrom = parseLocalDateToUtc(prevMondayStr, '00:00:00.000', tz);
    prevTo = parseLocalDateToUtc(prevEndStr, '23:59:59.999', tz);
  } else if (options.period === 'month') {
    // Del 1 del mes a hoy vs mismos días del mes anterior
    const [y, m, d] = todayStr.split('-').map(Number);
    const monthStartStr = formatYearMonthDay(y, m, 1);
    curFrom = parseLocalDateToUtc(monthStartStr, '00:00:00.000', tz);
    curTo = parseLocalDateToUtc(todayStr, '23:59:59.999', tz);
    const [prevYear, prevMonth] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const prevMonthStartStr = formatYearMonthDay(prevYear, prevMonth, 1);
    const daysInPrevMonth = getDaysInMonth(prevYear, prevMonth);
    const prevD = Math.min(d, daysInPrevMonth);
    const prevEndStr = formatYearMonthDay(prevYear, prevMonth, prevD);
    prevFrom = parseLocalDateToUtc(prevMonthStartStr, '00:00:00.000', tz);
    prevTo = parseLocalDateToUtc(prevEndStr, '23:59:59.999', tz);
  } else if (options.period === 'year') {
    // Del 1 de enero a hoy vs mismo rango del año anterior
    const [y, m, d] = todayStr.split('-').map(Number);
    const yearStartStr = formatYearMonthDay(y, 1, 1);
    curFrom = parseLocalDateToUtc(yearStartStr, '00:00:00.000', tz);
    curTo = parseLocalDateToUtc(todayStr, '23:59:59.999', tz);
    const prevYearStartStr = formatYearMonthDay(y - 1, 1, 1);
    const daysInPrevYearMonth = getDaysInMonth(y - 1, m);
    const prevD = Math.min(d, daysInPrevYearMonth);
    const prevEndStr = formatYearMonthDay(y - 1, m, prevD);
    prevFrom = parseLocalDateToUtc(prevYearStartStr, '00:00:00.000', tz);
    prevTo = parseLocalDateToUtc(prevEndStr, '23:59:59.999', tz);
  } else {
    // 'today' por defecto
    curFrom = parseLocalDateToUtc(todayStr, '00:00:00.000', tz);
    curTo = parseLocalDateToUtc(todayStr, '23:59:59.999', tz);
    const yesterdayStr = addDaysToDateStr(todayStr, -1);
    prevFrom = parseLocalDateToUtc(yesterdayStr, '00:00:00.000', tz);
    prevTo = parseLocalDateToUtc(yesterdayStr, '23:59:59.999', tz);
  }

  const result: BusinessDateRangeResult = {
    startDate: curFrom,
    endDate: curTo,
    fromIso: curFrom.toISOString(),
    toIso: curTo.toISOString(),
    prismaWhere: { gte: curFrom, lte: curTo },
  };

  if (prevFrom && prevTo) {
    result.previous = {
      startDate: prevFrom,
      endDate: prevTo,
      fromIso: prevFrom.toISOString(),
      toIso: prevTo.toISOString(),
      prismaWhere: { gte: prevFrom, lte: prevTo },
    };
  }

  return result;
}

/**
 * Retorna el filtro `{ gte?: Date, lte?: Date }` para Prisma WhereInput interpretando from y to en la zona del negocio.
 * Si no se especifica ni from ni to, retorna `{}` vacío.
 * Si se especifica solo from, cubre todo el día local de from.
 * Si se especifica solo to, cubre todo el día local de to.
 */
export function buildBusinessDateRange(
  from?: string | null,
  to?: string | null,
  timezone: string = DEFAULT_BUSINESS_TIMEZONE,
): { gte?: Date; lte?: Date } {
  const cleanFrom = from?.trim();
  const cleanTo = to?.trim();
  if (!cleanFrom && !cleanTo) return {};

  const range = resolveBusinessDateRange({ from: cleanFrom, to: cleanTo, timezone });
  return { gte: range.startDate, lte: range.endDate };
}

