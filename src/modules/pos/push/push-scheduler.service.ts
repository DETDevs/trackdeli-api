import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  BusinessProductStatus,
  BusinessProductType,
  CreditAccountStatus,
  CreditInstallmentStatus,
  PayableAccountStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BatchesService } from '../batches/batches.service';
import { ReportsService } from '../reports/reports.service';
import { resolveBusinessCoverage } from '../../superadmin/utils/membership-billing.util';
import {
  addDaysToDateStr,
  DEFAULT_BUSINESS_TIMEZONE,
  formatDateInTimezone,
  getEndOfDayInTimezone,
  getStartOfDayInTimezone,
  parseLocalDateToUtc,
} from '../../../common/utils/date.util';
import {
  PUSH_BATCH_BUSINESSES_SIZE,
  PUSH_EVENING_CRON_LOCK_ID,
  PUSH_MORNING_CRON_LOCK_ID,
  PushCategory,
} from './push.constants';
import { PushService } from './push.service';

export interface SchedulerRunSummary {
  skipped?: string;
  dateManagua?: string;
  businessesProcessed: number;
  byCategory: Record<string, { sent: number; failed: number; skipped: number }>;
  errors: number;
}

/**
 * 300b - Tareas programadas de avisos push en zona horaria America/Managua.
 * - Usa pg_try_advisory_lock en PostgreSQL para garantizar ejecución en una sola instancia en Railway.
 * - Recorre negocios en lotes de máximo 50 con tolerancia a fallos por negocio.
 * - Silencioso si PushService está apagado (sin credenciales Firebase).
 */
@Injectable()
export class PushSchedulerService {
  private readonly logger = new Logger(PushSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
    private readonly batchesService: BatchesService,
    private readonly reportsService: ReportsService,
  ) {}

  private formatMoney(amount: number): string {
    return Number(amount || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  private trackResult(
    summary: SchedulerRunSummary,
    category: PushCategory,
    res: { sent: number; failed: number; skipped: number | string },
  ): void {
    if (!summary.byCategory[category]) {
      summary.byCategory[category] = { sent: 0, failed: 0, skipped: 0 };
    }
    summary.byCategory[category].sent += res.sent || 0;
    summary.byCategory[category].failed += res.failed || 0;
    summary.byCategory[category].skipped +=
      typeof res.skipped === 'number' ? res.skipped : res.skipped ? 1 : 0;
  }

  /**
   * Itera negocios activos con POS en lotes de máximo 50.
   * Si se pasa targetBusinessIds (pruebas), procesa solo esos negocios.
   */
  private async iterateActivePosBusinesses(
    handler: (businessId: string) => Promise<void>,
    summary: SchedulerRunSummary,
    targetBusinessIds?: string[],
  ): Promise<void> {
    if (targetBusinessIds && targetBusinessIds.length > 0) {
      for (const businessId of targetBusinessIds) {
        try {
          await handler(businessId);
          summary.businessesProcessed++;
        } catch (err: any) {
          summary.errors++;
          this.logger.warn(
            `[PushSchedulerService] Error procesando negocio ${businessId}: ${err?.message || 'desconocido'}`,
          );
        }
      }
      return;
    }

    let cursorId: string | undefined = undefined;
    while (true) {
      const subs = await this.prisma.businessProductSubscription.findMany({
        where: {
          productType: BusinessProductType.POS,
          status: BusinessProductStatus.ACTIVE,
          business: { isActive: true },
        },
        select: { id: true, businessId: true },
        orderBy: { id: 'asc' },
        take: PUSH_BATCH_BUSINESSES_SIZE,
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      });

      if (subs.length === 0) break;

      for (const sub of subs) {
        try {
          await handler(sub.businessId);
          summary.businessesProcessed++;
        } catch (err: any) {
          summary.errors++;
          this.logger.warn(
            `[PushSchedulerService] Error procesando negocio ${sub.businessId}: ${err?.message || 'desconocido'}`,
          );
        }
      }

      if (subs.length < PUSH_BATCH_BUSINESSES_SIZE) break;
      cursorId = subs[subs.length - 1].id;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TAREA DIARIA 8:00 AM MANAGUA (POR_VENCER, CRÉDITO, PROVEEDORES, SUSCRIPCIÓN 3D)
  // ═══════════════════════════════════════════════════════════════

  @Cron('0 8 * * *', { timeZone: DEFAULT_BUSINESS_TIMEZONE })
  async handleMorningCron(): Promise<void> {
    await this.runMorningAlerts(new Date());
  }

  async runMorningAlerts(
    referenceDate: Date = new Date(),
    targetBusinessIds?: string[],
  ): Promise<SchedulerRunSummary> {
    const summary: SchedulerRunSummary = {
      businessesProcessed: 0,
      byCategory: {},
      errors: 0,
    };

    if (!this.pushService.isEnabled()) {
      summary.skipped = 'PUSH_DISABLED';
      return summary;
    }

    const lockRows = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${PUSH_MORNING_CRON_LOCK_ID}::int) AS locked
    `;
    if (!lockRows[0]?.locked) {
      summary.skipped = 'LOCK_HELD_BY_ANOTHER_INSTANCE';
      return summary;
    }

    try {
      const todayManagua = formatDateInTimezone(referenceDate, DEFAULT_BUSINESS_TIMEZONE);
      summary.dateManagua = todayManagua;

      await this.iterateActivePosBusinesses(
        async (businessId) => {
          await this.checkExpiringBatches(businessId, todayManagua, summary);
          await this.checkCreditDueTomorrow(businessId, todayManagua, summary);
          await this.checkCreditNewlyOverdue(businessId, todayManagua, summary);
          await this.checkPayablesDueSoon(businessId, todayManagua, summary);
          await this.checkSubscriptionDueIn3Days(businessId, referenceDate, summary);
        },
        summary,
        targetBusinessIds,
      );

      this.logger.log(
        `[PushSchedulerService] Tarea 8:00 AM (${todayManagua}) completada: negocios=${summary.businessesProcessed}, errores=${summary.errors}`,
      );
      return summary;
    } finally {
      await this.prisma.$executeRaw`
        SELECT pg_advisory_unlock(${PUSH_MORNING_CRON_LOCK_ID}::int)
      `.catch(() => {});
    }
  }

  /**
   * #2 POR_VENCER — reutiliza BatchesService.getExpiringBatches(businessId, 30).
   */
  private async checkExpiringBatches(
    businessId: string,
    todayManagua: string,
    summary: SchedulerRunSummary,
  ): Promise<void> {
    const expiring = await this.batchesService.getExpiringBatches(businessId, 30);
    const expiredCount = expiring?.summary?.vencidos?.count || 0;
    const criticalCount = expiring?.summary?.criticos?.count || 0;
    const totalAlert = expiredCount + criticalCount;
    if (totalAlert <= 0) return;

    const weekCount = (expiring.items || []).filter(
      (b: any) => b.daysRemaining != null && b.daysRemaining >= 0 && b.daysRemaining <= 7,
    ).length;

    let body: string;
    if (weekCount > 0) {
      body =
        weekCount === 1
          ? '1 lote vence esta semana. Revisá tu inventario.'
          : `${weekCount} lotes vencen esta semana. Revisá tu inventario.`;
    } else if (expiredCount > 0) {
      body =
        expiredCount === 1
          ? 'Tenés 1 lote vencido con existencia.'
          : `Tenés ${expiredCount} lotes vencidos con existencia.`;
    } else {
      body =
        totalAlert === 1
          ? '1 lote vence en los próximos 30 días.'
          : `${totalAlert} lotes vencen en los próximos 30 días.`;
    }

    const res = await this.pushService.send({
      businessId,
      roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
      category: PushCategory.POR_VENCER,
      title: 'Lotes por vencer',
      body,
      data: {
        category: PushCategory.POR_VENCER,
        screen: 'batches_expiring',
        id: todayManagua,
      },
      dedupeKey: `por_vencer:${businessId}:${todayManagua}`,
      dedupeWindowMinutes: 1440,
    });
    this.trackResult(summary, PushCategory.POR_VENCER, res);
  }

  /**
   * #6 CREDITO_POR_VENCER — cuentas/cuotas que vencen mañana (hora Managua).
   * Sin nombres ni teléfonos de clientes.
   */
  private async checkCreditDueTomorrow(
    businessId: string,
    todayManagua: string,
    summary: SchedulerRunSummary,
  ): Promise<void> {
    const tomorrowStr = addDaysToDateStr(todayManagua, 1);
    const tomorrowStart = getStartOfDayInTimezone(tomorrowStr, DEFAULT_BUSINESS_TIMEZONE);
    const tomorrowEnd = getEndOfDayInTimezone(tomorrowStr, DEFAULT_BUSINESS_TIMEZONE);

    const accounts = await this.prisma.creditAccount.findMany({
      where: {
        businessId,
        status: { notIn: [CreditAccountStatus.PAID, CreditAccountStatus.CANCELLED] },
        balance: { gt: 0 },
        OR: [
          { dueDate: { gte: tomorrowStart, lte: tomorrowEnd } },
          {
            installments: {
              some: {
                status: {
                  in: [CreditInstallmentStatus.PENDING, CreditInstallmentStatus.PARTIALLY_PAID],
                },
                dueDate: { gte: tomorrowStart, lte: tomorrowEnd },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        balance: true,
        installments: {
          where: {
            status: {
              in: [CreditInstallmentStatus.PENDING, CreditInstallmentStatus.PARTIALLY_PAID],
            },
            dueDate: { gte: tomorrowStart, lte: tomorrowEnd },
          },
          select: { amount: true, paidAmount: true },
        },
      },
    });

    if (accounts.length === 0) return;

    let totalDueTomorrow = 0;
    for (const acc of accounts) {
      if (acc.installments.length > 0) {
        for (const inst of acc.installments) {
          totalDueTomorrow += Math.max(0, Number(inst.amount) - Number(inst.paidAmount));
        }
      } else {
        totalDueTomorrow += Number(acc.balance);
      }
    }

    const count = accounts.length;
    const body =
      count === 1
        ? `1 cuenta por cobrar vence mañana (C$ ${this.formatMoney(totalDueTomorrow)})`
        : `${count} cuentas por cobrar vencen mañana (C$ ${this.formatMoney(totalDueTomorrow)})`;

    const res = await this.pushService.send({
      businessId,
      roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
      category: PushCategory.CREDITO_POR_VENCER,
      title: 'Cuentas por cobrar por vencer',
      body,
      data: {
        category: PushCategory.CREDITO_POR_VENCER,
        screen: 'credit_accounts',
        id: tomorrowStr,
      },
      dedupeKey: `credito_por_vencer:${businessId}:${todayManagua}`,
      dedupeWindowMinutes: 1440,
    });
    this.trackResult(summary, PushCategory.CREDITO_POR_VENCER, res);
  }

  /**
   * #7 CREDITO_VENCIDO — cuentas recién vencidas ayer (hora Managua) que no se avisaron antes.
   * Sin nombres ni teléfonos de clientes.
   */
  private async checkCreditNewlyOverdue(
    businessId: string,
    todayManagua: string,
    summary: SchedulerRunSummary,
  ): Promise<void> {
    const yesterdayStr = addDaysToDateStr(todayManagua, -1);
    const yesterdayStart = getStartOfDayInTimezone(yesterdayStr, DEFAULT_BUSINESS_TIMEZONE);
    const yesterdayEnd = getEndOfDayInTimezone(yesterdayStr, DEFAULT_BUSINESS_TIMEZONE);

    const accounts = await this.prisma.creditAccount.findMany({
      where: {
        businessId,
        status: { notIn: [CreditAccountStatus.PAID, CreditAccountStatus.CANCELLED] },
        balance: { gt: 0 },
        OR: [
          { dueDate: { gte: yesterdayStart, lte: yesterdayEnd } },
          {
            installments: {
              some: {
                status: {
                  in: [
                    CreditInstallmentStatus.PENDING,
                    CreditInstallmentStatus.PARTIALLY_PAID,
                    CreditInstallmentStatus.OVERDUE,
                  ],
                },
                dueDate: { gte: yesterdayStart, lte: yesterdayEnd },
              },
            },
          },
        ],
      },
      select: { id: true },
    });

    if (accounts.length === 0) return;

    const count = accounts.length;
    const body =
      count === 1
        ? '1 cuenta por cobrar venció ayer'
        : `${count} cuentas vencieron ayer`;

    const res = await this.pushService.send({
      businessId,
      roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
      category: PushCategory.CREDITO_VENCIDO,
      title: 'Cuentas vencidas',
      body,
      data: {
        category: PushCategory.CREDITO_VENCIDO,
        screen: 'credit_overdue',
        id: yesterdayStr,
      },
      dedupeKey: `credito_vencido:${businessId}:${todayManagua}`,
      dedupeWindowMinutes: 1440,
    });
    this.trackResult(summary, PushCategory.CREDITO_VENCIDO, res);
  }

  /**
   * #9 PAGO_PROVEEDOR_POR_VENCER — cuentas por pagar que vencen en los próximos 3 días (Managua).
   */
  private async checkPayablesDueSoon(
    businessId: string,
    todayManagua: string,
    summary: SchedulerRunSummary,
  ): Promise<void> {
    const todayStartUtc = parseLocalDateToUtc(todayManagua, '00:00:00.000', DEFAULT_BUSINESS_TIMEZONE);
    const next3DaysStr = addDaysToDateStr(todayManagua, 3);
    const next3DaysEndUtc = parseLocalDateToUtc(next3DaysStr, '23:59:59.999', DEFAULT_BUSINESS_TIMEZONE);

    const accounts = await this.prisma.payableAccount.findMany({
      where: {
        businessId,
        status: { in: [PayableAccountStatus.PENDING, PayableAccountStatus.PARTIALLY_PAID] },
        balance: { gt: 0 },
      },
      select: { id: true, dueDate: true, balance: true },
    });

    const dueSoon: { id: string; daysToDue: number }[] = [];
    for (const acc of accounts) {
      if (Number(acc.balance) <= 0) continue;
      const dueStr = formatDateInTimezone(acc.dueDate, DEFAULT_BUSINESS_TIMEZONE);
      const dueStartUtc = parseLocalDateToUtc(dueStr, '00:00:00.000', DEFAULT_BUSINESS_TIMEZONE);
      if (dueStartUtc >= todayStartUtc && dueStartUtc <= next3DaysEndUtc) {
        const daysToDue = Math.round(
          (dueStartUtc.getTime() - todayStartUtc.getTime()) / (1000 * 60 * 60 * 24),
        );
        dueSoon.push({ id: acc.id, daysToDue });
      }
    }

    if (dueSoon.length === 0) return;

    const minDays = Math.min(...dueSoon.map((d) => d.daysToDue));
    const count = dueSoon.length;
    const whenText =
      minDays === 0 ? 'hoy' : minDays === 1 ? 'mañana' : `en ${minDays} días`;
    const body =
      count === 1
        ? `1 pago a proveedor vence ${whenText}`
        : `${count} pagos a proveedores vencen ${whenText}`;

    const res = await this.pushService.send({
      businessId,
      roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
      category: PushCategory.PAGO_PROVEEDOR_POR_VENCER,
      title: 'Pagos a proveedores por vencer',
      body,
      data: {
        category: PushCategory.PAGO_PROVEEDOR_POR_VENCER,
        screen: 'payables',
        id: todayManagua,
      },
      dedupeKey: `pago_proveedor_por_vencer:${businessId}:${todayManagua}`,
      dedupeWindowMinutes: 1440,
    });
    this.trackResult(summary, PushCategory.PAGO_PROVEEDOR_POR_VENCER, res);
  }

  /**
   * #11 CUENTA_DISPOSITIVO (3 días antes del vencimiento de suscripción/módulo).
   */
  private async checkSubscriptionDueIn3Days(
    businessId: string,
    referenceDate: Date,
    summary: SchedulerRunSummary,
  ): Promise<void> {
    const coverage = await resolveBusinessCoverage(this.prisma, businessId, referenceDate);
    if (coverage.daysUntilDue === 3 && coverage.coveredUntilStr) {
      const res = await this.pushService.send({
        businessId,
        roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
        category: PushCategory.CUENTA_DISPOSITIVO,
        title: 'Tu suscripción vence pronto',
        body: 'Tu suscripción de NEXOL vence en 3 días. Contactá a NEXOL para renovarla.',
        data: {
          category: PushCategory.CUENTA_DISPOSITIVO,
          screen: 'subscription',
          id: coverage.coveredUntilStr,
        },
        dedupeKey: `module_due_3d:${businessId}:${coverage.coveredUntilStr}`,
        dedupeWindowMinutes: 60 * 24 * 7,
      });
      this.trackResult(summary, PushCategory.CUENTA_DISPOSITIVO, res);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TAREA DIARIA 20:00 (8:00 PM) MANAGUA — RESUMEN_DIA
  // ═══════════════════════════════════════════════════════════════

  @Cron('0 20 * * *', { timeZone: DEFAULT_BUSINESS_TIMEZONE })
  async handleEveningCron(): Promise<void> {
    await this.runEveningSummary(new Date());
  }

  async runEveningSummary(
    referenceDate: Date = new Date(),
    targetBusinessIds?: string[],
  ): Promise<SchedulerRunSummary> {
    const summary: SchedulerRunSummary = {
      businessesProcessed: 0,
      byCategory: {},
      errors: 0,
    };

    if (!this.pushService.isEnabled()) {
      summary.skipped = 'PUSH_DISABLED';
      return summary;
    }

    const lockRows = await this.prisma.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${PUSH_EVENING_CRON_LOCK_ID}::int) AS locked
    `;
    if (!lockRows[0]?.locked) {
      summary.skipped = 'LOCK_HELD_BY_ANOTHER_INSTANCE';
      return summary;
    }

    try {
      const todayManagua = formatDateInTimezone(referenceDate, DEFAULT_BUSINESS_TIMEZONE);
      summary.dateManagua = todayManagua;

      await this.iterateActivePosBusinesses(
        async (businessId) => {
          // Reutiliza los mismos números del reporte oficial del API (ReportsService.getSalesSummary)
          const report = await this.reportsService.getSalesSummary(
            businessId,
            undefined,
            todayManagua,
            todayManagua,
          );
          const totalSales = Number(report?.totalSales || 0);
          const totalRevenue = Number(report?.totalRevenue || 0);

          const salesLabel = totalSales === 1 ? 'venta' : 'ventas';
          const body = `Hoy: C$ ${this.formatMoney(totalRevenue)} en ${totalSales} ${salesLabel}`;

          const res = await this.pushService.send({
            businessId,
            roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
            category: PushCategory.RESUMEN_DIA,
            title: 'Resumen del día',
            body,
            data: {
              category: PushCategory.RESUMEN_DIA,
              screen: 'reports_daily',
              id: todayManagua,
            },
            dedupeKey: `resumen_dia:${businessId}:${todayManagua}`,
            dedupeWindowMinutes: 1440,
          });
          this.trackResult(summary, PushCategory.RESUMEN_DIA, res);
        },
        summary,
        targetBusinessIds,
      );

      this.logger.log(
        `[PushSchedulerService] Resumen diario 20:00 (${todayManagua}) completado: negocios=${summary.businessesProcessed}, errores=${summary.errors}`,
      );
      return summary;
    } finally {
      await this.prisma.$executeRaw`
        SELECT pg_advisory_unlock(${PUSH_EVENING_CRON_LOCK_ID}::int)
      `.catch(() => {});
    }
  }
}
