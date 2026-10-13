export const MANAGUA_TIMEZONE = 'America/Managua';

export interface ManaguaDateParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;
  minute: number;
  second: number;
}

export type DerivedMembershipStatus =
  | 'VIGENTE'
  | 'POR_VENCER'
  | 'EN_GRACIA'
  | 'VENCIDO'
  | 'NOT_CONTRACTED';

export interface BusinessBillingInfo {
  billing_anchor_day: number | null;
  current_period_start: string | null;
  due_date: string | null;
  grace_ends_at: string | null;
  membership_status: DerivedMembershipStatus;
  days_until_due: number | null;
  current_period_start_date: Date | null;
  due_date_date: Date | null;
  grace_ends_at_date: Date | null;
  is_active: boolean;
  is_in_grace: boolean;
}

/**
 * Obtiene los componentes de fecha/hora en la zona horaria America/Managua (UTC-6 sin horario de verano).
 */
export function getManaguaDateParts(date: Date): ManaguaDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: MANAGUA_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = parseInt(p.value, 10);
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
    second: map.second,
  };
}

/**
 * Formatea una fecha como YYYY-MM-DD en America/Managua.
 */
export function toManaguaDateString(date: Date): string {
  const { year, month, day } = getManaguaDateParts(date);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Parsea de manera segura una fecha dada como string o Date.
 * Si es un string en formato 'YYYY-MM-DD', se interpreta como medianoche en America/Managua (-06:00)
 * para evitar el desplazamiento de -1 día ocasionado por el parseo UTC de JavaScript.
 */
export function parseManaguaDate(input: string | Date | null | undefined): Date | null {
  if (!input) return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('-').map(Number);
      return createManaguaDate(y, m, d, 0, 0, 0, 0);
    }
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Crea una fecha con hora exacta en America/Managua (offset -06:00).
 */
export function createManaguaDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const padMs = (n: number) => n.toString().padStart(3, '0');
  const isoStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${padMs(millisecond)}-06:00`;
  return new Date(isoStr);
}

/**
 * Retorna la cantidad de días en el mes especificado (1-12).
 */
export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * Ajusta el día de cobro ancla para que no exceda los días del mes (ej. 31 ene -> 28 feb).
 */
export function getClampedDayForMonth(year: number, month: number, anchorDay: number): number {
  const maxDays = getDaysInMonth(year, month);
  return Math.min(anchorDay, maxDays);
}

/**
 * Retorna el siguiente mes y año calendario.
 */
export function getNextMonth(year: number, month: number): { year: number; month: number } {
  if (month === 12) {
    return { year: year + 1, month: 1 };
  }
  return { year, month: month + 1 };
}

/**
 * Calcula la fecha de vencimiento / próximo cobro (due_date) a partir del inicio del período y el día ancla.
 * Regla 1: Cada ciclo vence en ese mismo día del mes siguiente (ej. 10 oct -> 10 nov).
 * Si el mes no tiene ese día (ancla 31 o 30), vence el último día de ese mes (31 ene -> 28 feb -> 31 mar).
 */
export function calculateDueDate(periodStartDate: Date, anchorDay: number): Date {
  const startParts = getManaguaDateParts(periodStartDate);
  const next = getNextMonth(startParts.year, startParts.month);
  const dueDay = getClampedDayForMonth(next.year, next.month, anchorDay);
  return createManaguaDate(next.year, next.month, dueDay, 0, 0, 0, 0);
}

/**
 * Calcula cuándo termina el período de gracia de 3 días.
 * Regla 4: A partir del día siguiente al vencimiento corren 3 días de gracia (ej. 11, 12, 13 nov).
 * A las 00:00 del día siguiente a los 3 días de gracia (14 nov 00:00:00-06:00) pasa a Vencido/Suspendido.
 */
export function calculateGraceEndsAt(dueDate: Date): Date {
  // Due date a las 00:00 + 4 días exactos (96 horas en UTC-6 sin DST)
  return new Date(dueDate.getTime() + 4 * 24 * 60 * 60 * 1000);
}

/**
 * Calcula los días calendario que faltan para la fecha de vencimiento (due_date).
 * Negativo si ya venció (ej. 11 nov -> -1, 12 nov -> -2, 14 nov -> -4).
 */
export function calculateDaysUntilDue(dueDate: Date, now: Date): number {
  const dueParts = getManaguaDateParts(dueDate);
  const nowParts = getManaguaDateParts(now);

  const dueMidnight = Date.UTC(dueParts.year, dueParts.month - 1, dueParts.day);
  const nowMidnight = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);

  return Math.round((dueMidnight - nowMidnight) / (1000 * 60 * 60 * 24));
}

/**
 * Determina el estado de membresía derivado según las reglas de negocio:
 * - VIGENTE: faltan > 5 días para due_date.
 * - POR_VENCER: faltan <= 5 días para due_date (días 5, 4, 3, 2, 1, 0).
 * - EN_GRACIA: vencido hace 1 a 3 días (días -1, -2, -3).
 * - VENCIDO: vencido hace más de 3 días (días <= -4).
 */
export function calculateMembershipStatus(daysUntilDue: number): DerivedMembershipStatus {
  if (daysUntilDue > 5) {
    return 'VIGENTE';
  }
  if (daysUntilDue >= 0) {
    return 'POR_VENCER';
  }
  if (daysUntilDue >= -3) {
    return 'EN_GRACIA';
  }
  return 'VENCIDO';
}

/**
 * Determina si el negocio está habilitado para operar (Vigente, Por Vencer o En Gracia).
 */
export function isOperationallyActive(status: DerivedMembershipStatus): boolean {
  return status === 'VIGENTE' || status === 'POR_VENCER' || status === 'EN_GRACIA';
}

/**
 * Calcula el estado de membresía y facturación completo de un negocio.
 */
export function computeBusinessMembershipBilling(
  business: {
    id: string;
    createdAt: Date;
    billingAnchorDay?: number | null;
  },
  memberships: Array<{
    id: string;
    startDate: Date;
    endDate: Date;
    status: string;
    paidAt?: Date | null;
    createdAt?: Date;
  }>,
  now: Date = new Date(),
): BusinessBillingInfo {
  if (!memberships || memberships.length === 0) {
    return {
      billing_anchor_day: business.billingAnchorDay ?? null,
      current_period_start: null,
      due_date: null,
      grace_ends_at: null,
      membership_status: 'NOT_CONTRACTED',
      days_until_due: null,
      current_period_start_date: null,
      due_date_date: null,
      grace_ends_at_date: null,
      is_active: false,
      is_in_grace: false,
    };
  }

  // Ordenar por endDate desc, startDate desc
  const sorted = [...memberships].sort(
    (a, b) =>
      b.endDate.getTime() - a.endDate.getTime() ||
      b.startDate.getTime() - a.startDate.getTime(),
  );
  const latest = sorted[0];

  // La membresía más antigua para derivar ancla si no está guardado
  const oldest = [...memberships].sort(
    (a, b) => a.startDate.getTime() - b.startDate.getTime(),
  )[0];

  // Regla 4: El ancla es el día del pago registrado (paidAt) en America/Managua.
  // Si no hay paidAt, se recurre a startDate o a createdAt del negocio.
  const anchorSource = oldest.paidAt ?? oldest.startDate ?? business.createdAt;
  const anchorDay =
    business.billingAnchorDay ??
    getManaguaDateParts(anchorSource).day;

  // El período actual inicia en la fecha de inicio del último pago registrado
  const periodStart = latest.startDate;
  const startParts = getManaguaDateParts(periodStart);
  const currentPeriodStartDate = createManaguaDate(
    startParts.year,
    startParts.month,
    startParts.day,
    0,
    0,
    0,
    0,
  );

  const dueDate = calculateDueDate(currentPeriodStartDate, anchorDay);
  const graceEndsAt = calculateGraceEndsAt(dueDate);

  const daysUntilDue = calculateDaysUntilDue(dueDate, now);
  const status = calculateMembershipStatus(daysUntilDue);

  return {
    billing_anchor_day: anchorDay,
    current_period_start: toManaguaDateString(currentPeriodStartDate),
    due_date: toManaguaDateString(dueDate),
    grace_ends_at: graceEndsAt.toISOString(),
    membership_status: status,
    days_until_due: daysUntilDue,
    current_period_start_date: currentPeriodStartDate,
    due_date_date: dueDate,
    grace_ends_at_date: graceEndsAt,
    is_active: isOperationallyActive(status),
    is_in_grace: status === 'EN_GRACIA',
  };
}
