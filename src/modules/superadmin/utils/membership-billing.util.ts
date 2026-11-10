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
  monthly_amount?: number;
  monthly_amount_nio?: number;
  coverage_source?: CoverageSource;
  commercial_overdue?: boolean;
  is_commercial_blocked?: boolean;
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
 * Calcula cuándo termina el período de gracia dado un número arbitrario de días de gracia (default 3).
 * A las 00:00 del día siguiente a los N días de gracia (ej. 3 días -> +4 días a las 00:00).
 */
export function calculateGraceEndsAtDays(dueDate: Date, graceDays = 3): Date {
  return new Date(dueDate.getTime() + (graceDays + 1) * 24 * 60 * 60 * 1000);
}

/**
 * Agrega N meses calendario a una fecha en America/Managua, ajustando fin de mes.
 */
export function addMonthsManagua(startDate: Date, months: number, preferredDay?: number): Date {
  const parts = getManaguaDateParts(startDate);
  let y = parts.year;
  let m = parts.month + months;
  while (m > 12) {
    y++;
    m -= 12;
  }
  while (m < 1) {
    y--;
    m += 12;
  }
  const day = preferredDay !== undefined ? preferredDay : parts.day;
  const clamped = getClampedDayForMonth(y, m, day);
  return createManaguaDate(y, m, clamped, 0, 0, 0, 0);
}

/**
 * Calcula cuándo termina el período de gracia de 3 días.
 * Regla 4: A partir del día siguiente al vencimiento corren 3 días de gracia (ej. 11, 12, 13 nov).
 * A las 00:00 del día siguiente a los 3 días de gracia (14 nov 00:00:00-06:00) pasa a Vencido/Suspendido.
 */
export function calculateGraceEndsAt(dueDate: Date): Date {
  // Due date a las 00:00 + 4 días exactos (96 horas en UTC-6 sin DST)
  return calculateGraceEndsAtDays(dueDate, 3);
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
  const validMemberships = (memberships || []).filter(
    (m) => m.status !== 'CANCELLED',
  );

  if (!validMemberships || validMemberships.length === 0) {
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
  const sorted = [...validMemberships].sort(
    (a, b) =>
      b.endDate.getTime() - a.endDate.getTime() ||
      b.startDate.getTime() - a.startDate.getTime(),
  );
  const latest = sorted[0];

  // La membresía más antigua para derivar ancla si no está guardado
  const oldest = [...validMemberships].sort(
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

// ─────────────────────────────────────────────────────────────────────────────
// 244a — COBERTURA ÚNICA (Acuerdo comercial vs Membresía mensual)
// ─────────────────────────────────────────────────────────────────────────────

export type CoverageSource = 'MAINTENANCE_FREE' | 'MEMBERSHIP' | null;

export interface BusinessCoverageResolution {
  source: CoverageSource;
  coveredUntil: Date | null;
  coveredUntilStr: string | null;
  graceEndsAt: Date | null;
  graceEndsAtStr: string | null;
  isCovered: boolean;
  isInGrace: boolean;
  isCommercialBlocked: boolean;
  commercialOverdue: boolean;
  overdueAmount: number;
  overdueInstallmentsCount: number;
  daysUntilDue: number | null;
  status: DerivedMembershipStatus;
}

/**
 * Calcula la cobertura unificada de un negocio evaluando:
 * 1. Bloqueo comercial por cuotas de crédito vencidas fuera de su período de gracia.
 * 2. Mantenimiento gratis (12 meses o configurable) según el acuerdo comercial.
 * 3. Membresía mensual regular pagada.
 * Regla: Vale la cobertura que llegue más lejos.
 * Si hay bloqueo comercial por cuota vencida, isCovered es false.
 */
export function computeBusinessCoverage(
  business: {
    id: string;
    createdAt: Date;
    billingAnchorDay?: number | null;
  },
  agreement: {
    paymentType?: string | null;
    status?: string | null;
    graceDays?: number | null;
    maintenanceFreeEndsAt?: Date | string | null;
    installments?: Array<{
      installmentNumber: number;
      dueDate: Date | string;
      amount: any;
      paidAmount: any;
      paidAt?: Date | string | null;
    }> | null;
  } | null | undefined,
  memberships: Array<{
    id: string;
    startDate: Date | string;
    endDate: Date | string;
    status: string;
    paidAt?: Date | string | null;
    createdAt?: Date | string;
    amount?: any;
    currency?: string;
  }> | null | undefined,
  now: Date = new Date(),
): BusinessCoverageResolution {
  let isCommercialBlocked = false;
  let commercialOverdue = false;
  let overdueAmount = 0;
  let overdueInstallmentsCount = 0;

  // 1. Evaluación de crédito comercial
  if (agreement && agreement.paymentType === 'CREDITO' && agreement.status !== 'CANCELADO') {
    const graceDays = agreement.graceDays !== null && agreement.graceDays !== undefined ? agreement.graceDays : 3;
    const installments = agreement.installments || [];

    for (const inst of installments) {
      const amt = Number(inst.amount || 0);
      const paid = Number(inst.paidAmount || 0);

      if (paid < amt) {
        const dueDate = parseManaguaDate(inst.dueDate) || new Date(inst.dueDate);
        const instGrace = calculateGraceEndsAtDays(dueDate, graceDays);

        if (now >= dueDate) {
          commercialOverdue = true;
        }

        if (now >= instGrace) {
          isCommercialBlocked = true;
          overdueAmount += (amt - paid);
          overdueInstallmentsCount++;
        }
      }
    }
    overdueAmount = Math.round(overdueAmount * 100) / 100;
  }

  // 2. Mantenimiento gratis
  let maintDue: Date | null = null;
  let maintGrace: Date | null = null;
  let maintDays: number | null = null;

  if (agreement && agreement.maintenanceFreeEndsAt && agreement.status !== 'CANCELADO') {
    maintDue = parseManaguaDate(agreement.maintenanceFreeEndsAt) || new Date(agreement.maintenanceFreeEndsAt);
    maintGrace = calculateGraceEndsAt(maintDue);
    maintDays = calculateDaysUntilDue(maintDue, now);
  }

  // 3. Membresía mensual
  let memDue: Date | null = null;
  let memGrace: Date | null = null;
  let memDays: number | null = null;

  const validMemberships = (memberships || [])
    .filter((m) => m.status === 'ACTIVE' || m.status === 'EXPIRED')
    .map((m) => ({
      ...m,
      startDate: parseManaguaDate(m.startDate) || new Date(m.startDate),
      endDate: parseManaguaDate(m.endDate) || new Date(m.endDate),
      paidAt: m.paidAt ? (parseManaguaDate(m.paidAt) || new Date(m.paidAt)) : null,
      createdAt: m.createdAt ? (parseManaguaDate(m.createdAt) || new Date(m.createdAt)) : undefined,
    }));

  if (validMemberships.length > 0) {
    const billing = computeBusinessMembershipBilling(business, validMemberships, now);
    memDue = billing.due_date_date;
    memGrace = billing.grace_ends_at_date;
    memDays = billing.days_until_due;
  }

  // 4. Comparación: Vale la que llegue más lejos
  let chosenSource: CoverageSource = null;
  let chosenDue: Date | null = null;
  let chosenGrace: Date | null = null;
  let chosenDays: number | null = null;

  if (maintGrace && memGrace) {
    if (maintGrace.getTime() >= memGrace.getTime()) {
      chosenSource = 'MAINTENANCE_FREE';
      chosenDue = maintDue;
      chosenGrace = maintGrace;
      chosenDays = maintDays;
    } else {
      chosenSource = 'MEMBERSHIP';
      chosenDue = memDue;
      chosenGrace = memGrace;
      chosenDays = memDays;
    }
  } else if (maintGrace) {
    chosenSource = 'MAINTENANCE_FREE';
    chosenDue = maintDue;
    chosenGrace = maintGrace;
    chosenDays = maintDays;
  } else if (memGrace) {
    chosenSource = 'MEMBERSHIP';
    chosenDue = memDue;
    chosenGrace = memGrace;
    chosenDays = memDays;
  }

  // 5. Cobertura final
  const isTimeCovered = chosenGrace !== null && now < chosenGrace;
  const isCovered = isTimeCovered && !isCommercialBlocked;
  const isInGrace = chosenDue !== null && chosenGrace !== null && now >= chosenDue && now < chosenGrace;
  const status = chosenDays !== null ? calculateMembershipStatus(chosenDays) : 'NOT_CONTRACTED';

  return {
    source: chosenSource,
    coveredUntil: chosenDue,
    coveredUntilStr: chosenDue ? toManaguaDateString(chosenDue) : null,
    graceEndsAt: chosenGrace,
    graceEndsAtStr: chosenGrace ? chosenGrace.toISOString() : null,
    isCovered,
    isInGrace,
    isCommercialBlocked,
    commercialOverdue,
    overdueAmount,
    overdueInstallmentsCount,
    daysUntilDue: chosenDays,
    status,
  };
}

/**
 * Consulta la cobertura de un negocio en BD con una sola consulta liviana.
 */
export async function resolveBusinessCoverage(
  prisma: any,
  businessId: string,
  now: Date = new Date(),
): Promise<BusinessCoverageResolution> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      createdAt: true,
      billingAnchorDay: true,
      commercialAgreement: {
        include: {
          installments: {
            orderBy: { installmentNumber: 'asc' },
          },
        },
      },
      memberships: {
        where: {
          status: { in: ['ACTIVE', 'EXPIRED'] },
        },
        orderBy: [{ endDate: 'desc' }, { startDate: 'desc' }],
      },
    },
  });

  if (!business) {
    return {
      source: null,
      coveredUntil: null,
      coveredUntilStr: null,
      graceEndsAt: null,
      graceEndsAtStr: null,
      isCovered: false,
      isInGrace: false,
      isCommercialBlocked: false,
      commercialOverdue: false,
      overdueAmount: 0,
      overdueInstallmentsCount: 0,
      daysUntilDue: null,
      status: 'NOT_CONTRACTED',
    };
  }

  return computeBusinessCoverage(
    business,
    business.commercialAgreement,
    business.memberships,
    now,
  );
}

