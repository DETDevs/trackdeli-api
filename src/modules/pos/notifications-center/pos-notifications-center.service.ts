import { Injectable, Logger } from '@nestjs/common';
import {
  BusinessProductType,
  CashStatus,
  CreditAccountStatus,
  PayableAccountStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessProductsService } from '../../business-products/business-products.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import {
  calculateDaysUntilDue,
  computeBusinessCoverage,
  toManaguaDateString,
} from '../../superadmin/utils/membership-billing.util';

export type SystemNotificationCategory =
  | 'MEMBERSHIP'
  | 'RECEIVABLES'
  | 'PAYABLES'
  | 'EXPIRY'
  | 'INVENTORY'
  | 'OPERATIONS';

export type SystemNotificationSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface SystemNotificationRedirect {
  route: string;
  state?: Record<string, any>;
  actionLabel: string;
}

export interface SystemNotificationItem {
  id: string;
  fingerprint: string;
  category: SystemNotificationCategory;
  severity: SystemNotificationSeverity;
  title: string;
  body: string;
  count?: number;
  amount?: number;
  currency?: string;
  highlights?: string[];
  redirect: SystemNotificationRedirect;
}

export interface MembershipAlertSummary {
  status: string;
  source: string | null;
  coveredUntil: string | null;
  graceEndsAt: string | null;
  daysUntilDue: number | null;
  graceDaysRemaining: number | null;
  isInGrace: boolean;
  shouldShowTopBanner: boolean;
  bannerSeverity: 'CRITICAL' | 'WARNING' | null;
  bannerMessage: string | null;
  lastAmount: number | null;
  lastCurrency: string | null;
  commercialInstallment?: {
    installmentNumber: number;
    dueDate: string;
    remainingAmount: number;
    currency: string;
    daysUntilDue: number;
  } | null;
}

export interface PosNotificationCenterResponse {
  serverNow: string;
  membership: MembershipAlertSummary | null;
  items: SystemNotificationItem[];
  counts: {
    total: number;
    critical: number;
    warning: number;
    info: number;
  };
}

@Injectable()
export class PosNotificationsCenterService {
  private readonly logger = new Logger(PosNotificationsCenterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  private async safeRun<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      this.logger.warn(
        `[NotificationCenter] Detector "${label}" falló sin bloquear respuesta: ${err?.message || err}`,
      );
      return fallback;
    }
  }

  private round2(n: number): number {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  private fmtNio(n: number): string {
    return `C$${this.round2(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private fmtMoney(n: number, currency?: string | null): string {
    const prefix = currency === 'NIO' || currency === 'C$' ? 'C$' : currency === 'USD' ? 'US$' : 'C$';
    return `${prefix}${this.round2(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private fmtCalendarYmd(ymd: string | null | undefined): string {
    if (!ymd) return '';
    const [y, m, d] = ymd.slice(0, 10).split('-');
    if (!y || !m || !d) return ymd;
    return `${d}/${m}/${y}`;
  }

  private extractBatchYmd(expiryDate: Date | string | null | undefined): string | null {
    if (!expiryDate) return null;
    if (expiryDate instanceof Date) {
      return isNaN(expiryDate.getTime()) ? null : expiryDate.toISOString().slice(0, 10);
    }
    const raw = String(expiryDate).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    const parsed = new Date(raw);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }

  private computeCalendarDiffDays(targetYmd: string, todayYmd: string): number {
    const [ty, tm, td] = targetYmd.split('-').map(Number);
    const [ny, nm, nd] = todayYmd.split('-').map(Number);
    const utcTarget = Date.UTC(ty, tm - 1, td);
    const utcToday = Date.UTC(ny, nm - 1, nd);
    return Math.round((utcTarget - utcToday) / 86400000);
  }

  async getNotificationCenter(
    businessId: string,
    user: JwtPayload,
  ): Promise<PosNotificationCenterResponse> {
    const now = new Date();
    const todayYmd = toManaguaDateString(now);

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        isActive: true,
        createdAt: true,
        billingAnchorDay: true,
        tracksBatches: true,
        commercialAgreement: {
          include: {
            installments: {
              orderBy: { installmentNumber: 'asc' },
            },
          },
        },
        memberships: {
          where: { status: { in: ['ACTIVE', 'EXPIRED'] } },
          orderBy: [{ endDate: 'desc' }, { startDate: 'desc' }],
          select: {
            id: true,
            startDate: true,
            endDate: true,
            amount: true,
            currency: true,
            status: true,
            type: true,
            paidAt: true,
            createdAt: true,
          },
        },
      },
    });

    if (!business?.isActive) {
      return {
        serverNow: now.toISOString(),
        membership: null,
        items: [],
        counts: { total: 0, critical: 0, warning: 0, info: 0 },
      };
    }

    const [hasPos, hasCartera] = await Promise.all([
      this.safeRun('isActive:POS', () => this.businessProductsService.isActive(businessId, BusinessProductType.POS, now), false),
      this.safeRun('isActive:CARTERA', () => this.businessProductsService.isActive(businessId, BusinessProductType.CARTERA_COBRO, now), false),
    ]);

    const role = user.role;
    const isManager = role === UserRole.SUPERADMIN || role === UserRole.ENCARGADO;
    const isCashierOrManager = isManager || role === UserRole.CAJERO;

    const [
      membershipResult,
      receivablesItems,
      batchesAndStockItems,
      payablesItems,
      cashShiftItems,
      quotesItems,
    ] = await Promise.all([
      // A. Membresía y acuerdo comercial (solo ENCARGADO / SUPERADMIN)
      isManager
        ? this.safeRun('membership', async () => this.detectMembershipAlerts(business, now), {
            membership: null as MembershipAlertSummary | null,
            items: [] as SystemNotificationItem[],
          })
        : Promise.resolve({
            membership: null as MembershipAlertSummary | null,
            items: [] as SystemNotificationItem[],
          }),

      // B. Cartera por cobrar (solo ENCARGADO / SUPERADMIN + CARTERA_COBRO)
      isManager && hasCartera
        ? this.safeRun('receivables', () => this.detectReceivablesAlerts(businessId, now), [])
        : Promise.resolve([] as SystemNotificationItem[]),

      // C + D. Lotes y Stock/Costos (solo ENCARGADO / SUPERADMIN + POS)
      isManager && hasPos
        ? this.safeRun(
            'inventoryAndBatches',
            () => this.detectInventoryAndBatchAlerts(businessId, Boolean(business.tracksBatches), todayYmd),
            [],
          )
        : Promise.resolve([] as SystemNotificationItem[]),

      // E. Cuentas por pagar a proveedores (solo ENCARGADO / SUPERADMIN + CARTERA_COBRO)
      isManager && hasCartera
        ? this.safeRun('payables', () => this.detectPayablesAlerts(businessId, now), [])
        : Promise.resolve([] as SystemNotificationItem[]),

      // F1. Turno de caja abierto +14 h (ENCARGADO / SUPERADMIN / CAJERO + POS)
      isCashierOrManager && hasPos
        ? this.safeRun(
            'cashShift',
            () => this.detectLongOpenCashShift(businessId, role === UserRole.CAJERO ? user.sub : undefined, now),
            [],
          )
        : Promise.resolve([] as SystemNotificationItem[]),

      // F2. Proformas emitidas próximas a vencer <= 3 días (todos los roles operativos con POS)
      hasPos
        ? this.safeRun(
            'quotesExpiring',
            () => this.detectExpiringQuotes(businessId, role === UserRole.VENDEDOR ? user.sub : undefined, now),
            [],
          )
        : Promise.resolve([] as SystemNotificationItem[]),
    ]);

    const items: SystemNotificationItem[] = [
      ...membershipResult.items,
      ...receivablesItems,
      ...batchesAndStockItems,
      ...payablesItems,
      ...cashShiftItems,
      ...quotesItems,
    ];

    const severityRank: Record<SystemNotificationSeverity, number> = {
      CRITICAL: 0,
      WARNING: 1,
      INFO: 2,
    };
    items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

    const critical = items.filter((i) => i.severity === 'CRITICAL').length;
    const warning = items.filter((i) => i.severity === 'WARNING').length;
    const info = items.filter((i) => i.severity === 'INFO').length;

    return {
      serverNow: now.toISOString(),
      membership: membershipResult.membership,
      items,
      counts: {
        total: items.length,
        critical,
        warning,
        info,
      },
    };
  }

  private async detectMembershipAlerts(
    business: {
      id: string;
      createdAt: Date;
      billingAnchorDay: number | null;
      commercialAgreement: any;
      memberships: Array<{
        id: string;
        startDate: Date;
        endDate: Date;
        amount: any;
        currency: string;
        status: string;
        type: string;
        paidAt: Date | null;
        createdAt: Date;
      }>;
    },
    now: Date,
  ): Promise<{ membership: MembershipAlertSummary | null; items: SystemNotificationItem[] }> {
    const coverage = computeBusinessCoverage(
      business,
      business.commercialAgreement,
      business.memberships,
      now,
    );

    const hasPaidMembership = (business.memberships || []).some(
      (m) => m.status !== 'CANCELLED' && m.type !== 'TRIAL',
    );
    const hasRecurringOrMaintPlan =
      coverage.source === 'MAINTENANCE_FREE' ||
      (coverage.source === 'MEMBERSHIP' && hasPaidMembership);

    const latestPaidMembership = (business.memberships || []).find(
      (m) => m.status !== 'CANCELLED' && m.type !== 'TRIAL',
    );
    const lastAmount = latestPaidMembership ? this.round2(Number(latestPaidMembership.amount)) : null;
    const lastCurrency = latestPaidMembership?.currency || null;

    const items: SystemNotificationItem[] = [];
    let shouldShowTopBanner = false;
    let bannerSeverity: 'CRITICAL' | 'WARNING' | null = null;
    let bannerMessage: string | null = null;

    const graceDaysRemaining =
      coverage.isInGrace && coverage.daysUntilDue !== null
        ? Math.max(1, 4 + coverage.daysUntilDue)
        : null;

    const isMaintPlan = coverage.isMaintenancePlan;
    const planLabel = isMaintPlan ? 'mantenimiento' : 'membresía';
    const planLabelCap = isMaintPlan ? 'Mantenimiento' : 'Membresía';
    const maintFeeNio =
      isMaintPlan && business.commercialAgreement?.maintenanceFeeNio != null
        ? this.round2(Number(business.commercialAgreement.maintenanceFeeNio))
        : null;
    const displayAmount = isMaintPlan && maintFeeNio !== null ? maintFeeNio : lastAmount;
    const displayCurrency = isMaintPlan && maintFeeNio !== null ? 'NIO' : lastCurrency;

    if (hasRecurringOrMaintPlan && coverage.isInGrace && coverage.coveredUntilStr) {
      const dueFormatted = this.fmtCalendarYmd(coverage.coveredUntilStr);
      const graceLabel = `${graceDaysRemaining} ${graceDaysRemaining === 1 ? 'día' : 'días'} de gracia`;
      const body = `Tu ${planLabel} venció el ${dueFormatted}. Tenés ${graceLabel} para realizar tu pago y evitar interrupciones en el sistema.`;

      shouldShowTopBanner = true;
      bannerSeverity = 'CRITICAL';
      bannerMessage = body;

      items.push({
        id: 'MEMBERSHIP_IN_GRACE',
        fingerprint: `MEMBERSHIP_IN_GRACE:${coverage.coveredUntilStr}:${graceDaysRemaining}`,
        category: 'MEMBERSHIP',
        severity: 'CRITICAL',
        title: `${planLabelCap} vencid${isMaintPlan ? 'o' : 'a'} · Quedan ${graceLabel}`,
        body,
        ...(displayAmount !== null ? { amount: displayAmount, currency: displayCurrency || 'USD' } : {}),
        redirect: {
          route: '#membership-modal',
          actionLabel: isMaintPlan ? 'Ver estado de mantenimiento' : 'Ver estado de membresía',
        },
      });
    } else if (
      hasRecurringOrMaintPlan &&
      coverage.daysUntilDue !== null &&
      coverage.daysUntilDue >= 0 &&
      coverage.daysUntilDue <= 7 &&
      coverage.coveredUntilStr
    ) {
      const days = coverage.daysUntilDue;
      const dueFormatted = this.fmtCalendarYmd(coverage.coveredUntilStr);
      const severity: SystemNotificationSeverity = days <= 2 ? 'CRITICAL' : 'WARNING';
      const title =
        days === 0
          ? `Hoy vence tu ${planLabel}`
          : days === 1
            ? `Mañana vence tu ${planLabel}`
            : `Quedan ${days} días para el pago de tu ${planLabel}`;
      const amountSuffix =
        displayAmount !== null && displayAmount > 0
          ? ` (${this.fmtMoney(displayAmount, displayCurrency)})`
          : '';
      const body = `Tu fecha de renovación es el ${dueFormatted}${amountSuffix}. Estate listo con tu pago para mantener el sistema activo sin interrupciones.`;

      shouldShowTopBanner = true;
      bannerSeverity = severity;
      bannerMessage =
        days === 0
          ? `Hoy vence tu ${planLabel} (${dueFormatted})${amountSuffix}. Estate listo con tu pago.`
          : `Quedan ${days} ${days === 1 ? 'día' : 'días'} para tu ${planLabel} (vence el ${dueFormatted})${amountSuffix}. Estate listo con tu pago.`;

      items.push({
        id: 'MEMBERSHIP_DUE_SOON',
        fingerprint: `MEMBERSHIP_DUE_SOON:${coverage.coveredUntilStr}:${days}`,
        category: 'MEMBERSHIP',
        severity,
        title,
        body,
        ...(displayAmount !== null ? { amount: displayAmount, currency: displayCurrency || 'USD' } : {}),
        redirect: {
          route: '#membership-modal',
          actionLabel: isMaintPlan ? 'Ver detalle de mantenimiento' : 'Ver detalle de membresía',
        },
      });
    }

    let commercialInstallment: MembershipAlertSummary['commercialInstallment'] = null;
    const agreement = business.commercialAgreement;
    if (
      agreement &&
      agreement.paymentType === 'CREDITO' &&
      agreement.status !== 'CANCELADO' &&
      Array.isArray(agreement.installments)
    ) {
      const nextUnpaid = agreement.installments.find(
        (inst: any) => Number(inst.paidAmount || 0) < Number(inst.amount || 0),
      );
      if (nextUnpaid) {
        const instDueDate = new Date(nextUnpaid.dueDate);
        const instDays = calculateDaysUntilDue(instDueDate, now);
        const remaining = this.round2(Number(nextUnpaid.amount) - Number(nextUnpaid.paidAmount || 0));
        const instDueYmd = toManaguaDateString(instDueDate);

        commercialInstallment = {
          installmentNumber: nextUnpaid.installmentNumber,
          dueDate: instDueYmd,
          remainingAmount: remaining,
          currency: agreement.currency || 'USD',
          daysUntilDue: instDays,
        };

        if (instDays <= 7) {
          const isOverdue = instDays < 0;
          const severity: SystemNotificationSeverity = isOverdue || instDays <= 2 ? 'CRITICAL' : 'WARNING';
          const dueFmt = this.fmtCalendarYmd(instDueYmd);
          const title = isOverdue
            ? `Cuota comercial #${nextUnpaid.installmentNumber} vencida`
            : instDays === 0
              ? `Hoy vence tu cuota comercial #${nextUnpaid.installmentNumber}`
              : `Quedan ${instDays} ${instDays === 1 ? 'día' : 'días'} para tu cuota comercial #${nextUnpaid.installmentNumber}`;
          const body = isOverdue
            ? `Tenés una cuota vencida desde el ${dueFmt}. Saldo pendiente: ${this.fmtMoney(remaining, agreement.currency)}.`
            : `Saldo pendiente: ${this.fmtMoney(remaining, agreement.currency)} (fecha límite ${dueFmt}).`;

          items.push({
            id: 'COMMERCIAL_INSTALLMENT_DUE',
            fingerprint: `COMMERCIAL_INSTALLMENT:${nextUnpaid.installmentNumber}:${instDueYmd}:${instDays}`,
            category: 'MEMBERSHIP',
            severity,
            title,
            body,
            amount: remaining,
            currency: agreement.currency || 'USD',
            redirect: {
              route: '#membership-modal',
              actionLabel: 'Ver detalle del acuerdo',
            },
          });

          if (!shouldShowTopBanner || severity === 'CRITICAL') {
            shouldShowTopBanner = true;
            bannerSeverity = severity;
            bannerMessage = `${title} · ${body}`;
          }
        }
      }
    }

    if (!hasRecurringOrMaintPlan && !commercialInstallment) {
      return { membership: null, items };
    }

    return {
      membership: {
        status: coverage.status,
        source: coverage.source,
        coveredUntil: coverage.coveredUntilStr,
        graceEndsAt: coverage.graceEndsAtStr,
        daysUntilDue: coverage.daysUntilDue,
        graceDaysRemaining,
        isInGrace: coverage.isInGrace,
        shouldShowTopBanner,
        bannerSeverity,
        bannerMessage,
        lastAmount,
        lastCurrency,
        commercialInstallment,
      },
      items,
    };
  }

  private async detectReceivablesAlerts(
    businessId: string,
    now: Date,
  ): Promise<SystemNotificationItem[]> {
    const accounts = await this.prisma.creditAccount.findMany({
      where: {
        businessId,
        balance: { gt: 0 },
        status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
      },
      include: {
        customer: {
          select: { id: true, name: true, creditLimit: true, groupId: true },
        },
        installments: {
          where: { status: { notIn: ['PAID', 'CANCELLED'] } },
          orderBy: { dueDate: 'asc' },
        },
      },
    });

    if (accounts.length === 0) return [];

    const overdueCustomers = new Map<string, { name: string; amount: number; hasGroup: boolean }>();
    const dueSoonCustomers = new Map<
      string,
      { name: string; amount: number; minDays: number; hasGroup: boolean }
    >();
    const totalDebtByCustomer = new Map<
      string,
      { name: string; debt: number; limit: number; hasGroup: boolean }
    >();

    for (const acc of accounts) {
      const bal = this.round2(Number(acc.balance));
      if (bal <= 0) continue;

      const cust = acc.customer;
      const hasGroup = Boolean(cust.groupId);
      const nextUnpaidInst = acc.installments?.[0];
      const effectiveDueDate = nextUnpaidInst ? new Date(nextUnpaidInst.dueDate) : new Date(acc.dueDate);
      const daysUntilDue = calculateDaysUntilDue(effectiveDueDate, now);
      const isOverdue = acc.status === CreditAccountStatus.OVERDUE || daysUntilDue < 0;

      if (isOverdue) {
        const entry = overdueCustomers.get(cust.id) || { name: cust.name, amount: 0, hasGroup };
        entry.amount = this.round2(entry.amount + bal);
        overdueCustomers.set(cust.id, entry);
      } else if (daysUntilDue >= 0 && daysUntilDue <= 5) {
        const entry = dueSoonCustomers.get(cust.id) || {
          name: cust.name,
          amount: 0,
          minDays: daysUntilDue,
          hasGroup,
        };
        entry.amount = this.round2(entry.amount + bal);
        entry.minDays = Math.min(entry.minDays, daysUntilDue);
        dueSoonCustomers.set(cust.id, entry);
      }

      if (cust.creditLimit && Number(cust.creditLimit) > 0) {
        const limitEntry = totalDebtByCustomer.get(cust.id) || {
          name: cust.name,
          debt: 0,
          limit: Number(cust.creditLimit),
          hasGroup,
        };
        limitEntry.debt = this.round2(limitEntry.debt + bal);
        totalDebtByCustomer.set(cust.id, limitEntry);
      }
    }

    const items: SystemNotificationItem[] = [];

    if (overdueCustomers.size > 0) {
      const list = Array.from(overdueCustomers.values()).sort((a, b) => b.amount - a.amount);
      const totalOverdue = this.round2(list.reduce((s, c) => s + c.amount, 0));
      const allInGroup = list.every((c) => c.hasGroup);
      items.push({
        id: 'CREDIT_OVERDUE',
        fingerprint: `CREDIT_OVERDUE:${list.length}:${totalOverdue}`,
        category: 'RECEIVABLES',
        severity: 'CRITICAL',
        title: `${list.length} ${list.length === 1 ? 'cliente moroso' : 'clientes morosos'} · ${this.fmtNio(totalOverdue)}`,
        body:
          list.length === 1
            ? `${list[0].name} tiene saldo vencido por ${this.fmtNio(list[0].amount)}.`
            : `${list[0].name} y ${list.length - 1} ${list.length - 1 === 1 ? 'cliente más tienen' : 'clientes más tienen'} saldos vencidos por cobrar.`,
        count: list.length,
        amount: totalOverdue,
        currency: 'NIO',
        highlights: list.slice(0, 3).map((c) => `${c.name} (${this.fmtNio(c.amount)})`),
        redirect: {
          route: '/finances',
          state: { tab: 'receivables', section: allInGroup ? 'GROUPS' : 'INDIVIDUAL', filter: 'OVERDUE' },
          actionLabel: 'Ver clientes morosos',
        },
      });
    }

    if (dueSoonCustomers.size > 0) {
      const list = Array.from(dueSoonCustomers.values()).sort((a, b) => a.minDays - b.minDays);
      const totalSoon = this.round2(list.reduce((s, c) => s + c.amount, 0));
      const allInGroup = list.every((c) => c.hasGroup);
      items.push({
        id: 'CREDIT_DUE_SOON',
        fingerprint: `CREDIT_DUE_SOON:${list.length}:${totalSoon}`,
        category: 'RECEIVABLES',
        severity: 'WARNING',
        title: `${list.length} ${list.length === 1 ? 'crédito próximo a vencer' : 'créditos próximos a vencer'}`,
        body: `${this.fmtNio(totalSoon)} por vencer en los próximos 5 días. Anticipá el recordatorio de pago.`,
        count: list.length,
        amount: totalSoon,
        currency: 'NIO',
        highlights: list.slice(0, 3).map((c) =>
          `${c.name} (${c.minDays === 0 ? 'vence hoy' : `en ${c.minDays} d`} · ${this.fmtNio(c.amount)})`,
        ),
        redirect: {
          route: '/finances',
          state: { tab: 'receivables', section: allInGroup ? 'GROUPS' : 'INDIVIDUAL', filter: 'DUE_SOON' },
          actionLabel: 'Ver próximos cobros',
        },
      });
    }

    const nearLimitList = Array.from(totalDebtByCustomer.values())
      .filter((c) => c.limit > 0 && c.debt / c.limit >= 0.85)
      .sort((a, b) => b.debt / b.limit - a.debt / a.limit);

    if (nearLimitList.length > 0) {
      const allInGroup = nearLimitList.every((c) => c.hasGroup);
      items.push({
        id: 'CREDIT_NEAR_LIMIT',
        fingerprint: `CREDIT_NEAR_LIMIT:${nearLimitList.length}:${nearLimitList.map((c) => c.name).slice(0, 3).join(',')}`,
        category: 'RECEIVABLES',
        severity: 'INFO',
        title: `${nearLimitList.length} ${nearLimitList.length === 1 ? 'cliente cerca del límite de crédito' : 'clientes cerca del límite de crédito'}`,
        body: `Superaron el 85% de su línea de crédito autorizada.`,
        count: nearLimitList.length,
        highlights: nearLimitList.slice(0, 3).map((c) => {
          const pct = Math.min(999, Math.round((c.debt / c.limit) * 100));
          return `${c.name} (${pct}% usado)`;
        }),
        redirect: {
          route: '/finances',
          state: { tab: 'receivables', section: allInGroup ? 'GROUPS' : 'INDIVIDUAL', filter: 'ALL' },
          actionLabel: 'Revisar límites en cartera',
        },
      });
    }

    return items;
  }

  private async detectInventoryAndBatchAlerts(
    businessId: string,
    tracksBatches: boolean,
    todayYmd: string,
  ): Promise<SystemNotificationItem[]> {
    const items: SystemNotificationItem[] = [];
    const expiredQtyByProduct = new Map<string, number>();

    if (tracksBatches) {
      const batches = await this.prisma.productBatch.findMany({
        where: {
          businessId,
          quantity: { gt: 0 },
          product: { isActive: true },
        },
        include: {
          product: {
            select: { id: true, name: true, cost: true, unit: true },
          },
        },
      });

      let expiredCount = 0;
      let expiredUnits = 0;
      let expiredLoss = 0;
      const expiredHighlights: string[] = [];

      let criticalCount = 0;
      let criticalRisk = 0;
      const criticalHighlights: string[] = [];

      let noDateCount = 0;
      const noDateHighlights: string[] = [];

      for (const b of batches) {
        const qty = Number(b.quantity);
        const unitCost = Number(b.cost ?? b.product?.cost ?? 0);
        const val = this.round2(qty * unitCost);
        const expYmd = this.extractBatchYmd(b.expiryDate);

        if (!expYmd) {
          noDateCount++;
          if (noDateHighlights.length < 3) {
            noDateHighlights.push(`${b.product.name} (${b.batchNumber})`);
          }
          continue;
        }

        const days = this.computeCalendarDiffDays(expYmd, todayYmd);
        if (days < 0) {
          expiredCount++;
          expiredUnits += qty;
          expiredLoss = this.round2(expiredLoss + val);
          expiredQtyByProduct.set(
            b.product.id,
            (expiredQtyByProduct.get(b.product.id) || 0) + qty,
          );
          if (expiredHighlights.length < 3) {
            expiredHighlights.push(
              `${b.product.name} · Lote ${b.batchNumber} (${qty} ${b.product.unit || 'UND'})`,
            );
          }
        } else if (days <= 30) {
          criticalCount++;
          criticalRisk = this.round2(criticalRisk + val);
          if (criticalHighlights.length < 3) {
            criticalHighlights.push(
              `${b.product.name} · Lote ${b.batchNumber} (${days === 0 ? 'hoy' : `en ${days} d`})`,
            );
          }
        }
      }

      if (expiredCount > 0) {
        items.push({
          id: 'BATCH_EXPIRED',
          fingerprint: `BATCH_EXPIRED:${expiredCount}:${expiredUnits}:${expiredLoss}`,
          category: 'EXPIRY',
          severity: 'CRITICAL',
          title: `${expiredCount} ${expiredCount === 1 ? 'lote vencido en inventario' : 'lotes vencidos en inventario'} · ${this.fmtNio(expiredLoss)}`,
          body: `Hay ${Math.round(expiredUnits * 100) / 100} unidades vencidas en stock contable que no se pueden vender y representan pérdida directa.`,
          count: expiredCount,
          amount: expiredLoss,
          currency: 'NIO',
          highlights: expiredHighlights,
          redirect: {
            route: '/reports',
            state: { tab: 'batches', subTab: 'losses' },
            actionLabel: 'Ver pérdidas y dar de baja',
          },
        });
      }

      if (criticalCount > 0) {
        items.push({
          id: 'BATCH_EXPIRING_30D',
          fingerprint: `BATCH_EXPIRING_30D:${criticalCount}:${criticalRisk}`,
          category: 'EXPIRY',
          severity: 'WARNING',
          title: `${criticalCount} ${criticalCount === 1 ? 'lote crítico por vencer (≤30 d)' : 'lotes críticos por vencer (≤30 d)'}`,
          body: `Capital en riesgo: ${this.fmtNio(criticalRisk)}. Priorizá su rotación o liquidación antes de que venza.`,
          count: criticalCount,
          amount: criticalRisk,
          currency: 'NIO',
          highlights: criticalHighlights,
          redirect: {
            route: '/reports',
            state: { tab: 'batches', subTab: 'expirations', statusFilter: 'CRITICAL' },
            actionLabel: 'Ver alertas de lotes',
          },
        });
      }

      if (noDateCount > 0) {
        items.push({
          id: 'BATCH_NO_DATE',
          fingerprint: `BATCH_NO_DATE:${noDateCount}`,
          category: 'EXPIRY',
          severity: 'INFO',
          title: `${noDateCount} ${noDateCount === 1 ? 'lote sin fecha de vencimiento' : 'lotes sin fecha de vencimiento'}`,
          body: `Completá la fecha para que el control FEFO priorice las salidas y genere alertas a tiempo.`,
          count: noDateCount,
          highlights: noDateHighlights,
          redirect: {
            route: '/reports',
            state: { tab: 'batches', subTab: 'expirations', statusFilter: 'NO_DATE' },
            actionLabel: 'Completar fechas',
          },
        });
      }
    }

    const products = await this.prisma.product.findMany({
      where: {
        businessId,
        isActive: true,
        type: 'PRODUCT',
      },
      select: {
        id: true,
        name: true,
        stock: true,
        minStock: true,
        trackStock: true,
        isRecipe: true,
        cost: true,
        unit: true,
      },
    });

    const outProducts: Array<{ name: string; stockLabel: string }> = [];
    const lowProducts: Array<{ name: string; stockLabel: string }> = [];
    const nearLowProducts: Array<{ name: string; stockLabel: string }> = [];
    const noCostProducts: string[] = [];

    for (const p of products) {
      if (!p.isRecipe && (p.cost === null || Number(p.cost) <= 0)) {
        noCostProducts.push(p.name);
      }

      if (p.trackStock === false) continue;

      const rawStock = Number(p.stock || 0);
      const expiredQty = expiredQtyByProduct.get(p.id) || 0;
      const sellableStock = Math.max(0, rawStock - expiredQty);
      const minStock = Number(p.minStock || 0);
      const unit = p.unit || 'UND';

      if (sellableStock <= 0) {
        outProducts.push({
          name: p.name,
          stockLabel: expiredQty > 0 && rawStock > 0 ? '100% vencido' : `0 ${unit}`,
        });
      } else if (minStock > 0 && sellableStock <= minStock) {
        lowProducts.push({
          name: p.name,
          stockLabel: `${sellableStock}/${minStock} ${unit}`,
        });
      } else if (
        minStock > 0 &&
        sellableStock > minStock &&
        sellableStock <= Math.max(minStock + 2, Math.ceil(minStock * 1.35))
      ) {
        nearLowProducts.push({
          name: p.name,
          stockLabel: `${sellableStock} (mín. ${minStock})`,
        });
      }
    }

    if (outProducts.length > 0) {
      items.push({
        id: 'STOCK_OUT',
        fingerprint: `STOCK_OUT:${outProducts.length}:${outProducts.slice(0, 3).map((p) => p.name).join(',')}`,
        category: 'INVENTORY',
        severity: 'CRITICAL',
        title: `${outProducts.length} ${outProducts.length === 1 ? 'producto agotado' : 'productos agotados'}`,
        body: `Sin existencias disponibles para la venta en punto de venta.`,
        count: outProducts.length,
        highlights: outProducts.slice(0, 3).map((p) => `${p.name} (${p.stockLabel})`),
        redirect: {
          route: '/products',
          state: { filter: 'OUT' },
          actionLabel: 'Ver productos agotados',
        },
      });
    }

    if (lowProducts.length > 0) {
      items.push({
        id: 'STOCK_LOW',
        fingerprint: `STOCK_LOW:${lowProducts.length}`,
        category: 'INVENTORY',
        severity: 'WARNING',
        title: `${lowProducts.length} ${lowProducts.length === 1 ? 'producto con stock bajo' : 'productos con stock bajo'}`,
        body: `Alcanzaron o bajaron del stock mínimo configurado. Planificá reabastecimiento.`,
        count: lowProducts.length,
        highlights: lowProducts.slice(0, 3).map((p) => `${p.name} (${p.stockLabel})`),
        redirect: {
          route: '/products',
          state: { filter: 'LOW' },
          actionLabel: 'Ver stock bajo',
        },
      });
    }

    if (nearLowProducts.length > 0) {
      items.push({
        id: 'STOCK_NEAR_LOW',
        fingerprint: `STOCK_NEAR_LOW:${nearLowProducts.length}`,
        category: 'INVENTORY',
        severity: 'INFO',
        title: `${nearLowProducts.length} ${nearLowProducts.length === 1 ? 'producto próximo a stock mínimo' : 'productos próximos a stock mínimo'}`,
        body: `A punto de entrar en alerta de bajo stock. Podés anticipar la compra.`,
        count: nearLowProducts.length,
        highlights: nearLowProducts.slice(0, 3).map((p) => `${p.name} · ${p.stockLabel}`),
        redirect: {
          route: '/products',
          state: { filter: 'NEAR_LOW' },
          actionLabel: 'Ver próximos a mínimo',
        },
      });
    }

    if (noCostProducts.length > 0) {
      items.push({
        id: 'PRODUCT_NO_COST',
        fingerprint: `PRODUCT_NO_COST:${noCostProducts.length}`,
        category: 'INVENTORY',
        severity: 'INFO',
        title: `${noCostProducts.length} ${noCostProducts.length === 1 ? 'producto sin costo registrado' : 'productos sin costo registrado'}`,
        body: `Completá el costo unitario para calcular ganancias reales y pérdidas exactas.`,
        count: noCostProducts.length,
        highlights: noCostProducts.slice(0, 3),
        redirect: {
          route: '/products',
          state: { filter: 'NO_COST' },
          actionLabel: 'Completar costos',
        },
      });
    }

    return items;
  }

  private async detectPayablesAlerts(
    businessId: string,
    now: Date,
  ): Promise<SystemNotificationItem[]> {
    const accounts = await this.prisma.payableAccount.findMany({
      where: {
        businessId,
        balance: { gt: 0 },
        status: { in: [PayableAccountStatus.PENDING, PayableAccountStatus.PARTIALLY_PAID] },
      },
      include: {
        supplier: { select: { name: true } },
      },
    });

    if (accounts.length === 0) return [];

    let overdueCount = 0;
    let overdueAmount = 0;
    const overdueSuppliers = new Set<string>();

    let soonCount = 0;
    let soonAmount = 0;
    const soonSuppliers = new Set<string>();

    for (const acc of accounts) {
      const bal = this.round2(Number(acc.balance));
      if (bal <= 0) continue;
      const days = calculateDaysUntilDue(new Date(acc.dueDate), now);
      if (days < 0) {
        overdueCount++;
        overdueAmount = this.round2(overdueAmount + bal);
        if (acc.supplier?.name) overdueSuppliers.add(acc.supplier.name);
      } else if (days <= 7) {
        soonCount++;
        soonAmount = this.round2(soonAmount + bal);
        if (acc.supplier?.name) soonSuppliers.add(acc.supplier.name);
      }
    }

    const items: SystemNotificationItem[] = [];

    if (overdueCount > 0) {
      items.push({
        id: 'PAYABLE_OVERDUE',
        fingerprint: `PAYABLE_OVERDUE:${overdueCount}:${overdueAmount}`,
        category: 'PAYABLES',
        severity: 'CRITICAL',
        title: `${overdueCount} ${overdueCount === 1 ? 'cuenta por pagar vencida' : 'cuentas por pagar vencidas'} · ${this.fmtNio(overdueAmount)}`,
        body: `Comprobantes de crédito con proveedores fuera de fecha límite de pago.`,
        count: overdueCount,
        amount: overdueAmount,
        currency: 'NIO',
        highlights: Array.from(overdueSuppliers).slice(0, 3),
        redirect: {
          route: '/finances',
          state: { tab: 'payables', onlyOverdue: true },
          actionLabel: 'Ver cuentas vencidas',
        },
      });
    }

    if (soonCount > 0) {
      items.push({
        id: 'PAYABLE_DUE_SOON',
        fingerprint: `PAYABLE_DUE_SOON:${soonCount}:${soonAmount}`,
        category: 'PAYABLES',
        severity: 'WARNING',
        title: `${soonCount} ${soonCount === 1 ? 'pago a proveedor en ≤ 7 días' : 'pagos a proveedores en ≤ 7 días'}`,
        body: `Saldo próximo a vencer: ${this.fmtNio(soonAmount)}.`,
        count: soonCount,
        amount: soonAmount,
        currency: 'NIO',
        highlights: Array.from(soonSuppliers).slice(0, 3),
        redirect: {
          route: '/finances',
          state: { tab: 'payables', onlyOverdue: false },
          actionLabel: 'Ver próximos pagos',
        },
      });
    }

    return items;
  }

  private async detectLongOpenCashShift(
    businessId: string,
    cashierIdOnly: string | undefined,
    now: Date,
  ): Promise<SystemNotificationItem[]> {
    const threshold = new Date(now.getTime() - 14 * 60 * 60 * 1000);
    const openShifts = await this.prisma.cashRegister.findMany({
      where: {
        businessId,
        status: CashStatus.OPEN,
        openedAt: { lte: threshold },
        ...(cashierIdOnly ? { cashierId: cashierIdOnly } : {}),
      },
      include: {
        cashier: { select: { name: true } },
      },
      orderBy: { openedAt: 'asc' },
    });

    if (openShifts.length === 0) return [];

    const oldest = openShifts[0];
    const hoursOpen = Math.floor((now.getTime() - oldest.openedAt.getTime()) / (1000 * 60 * 60));

    return [
      {
        id: 'CASH_SHIFT_LONG_OPEN',
        fingerprint: `CASH_SHIFT_LONG_OPEN:${openShifts.map((s) => s.id).join(',')}`,
        category: 'OPERATIONS',
        severity: 'WARNING',
        title:
          openShifts.length === 1
            ? `Turno de caja abierto hace ${hoursOpen} h`
            : `${openShifts.length} turnos de caja con +14 h sin cierre`,
        body: `Revisá el arqueo y cerrá el turno si la jornada ya terminó para cuadrar el efectivo.`,
        count: openShifts.length,
        highlights: openShifts
          .slice(0, 3)
          .map((s) => `${s.cashier?.name || 'Cajero'}${s.deviceName ? ` (${s.deviceName})` : ''}`),
        redirect: {
          route: '/cash-register',
          actionLabel: 'Ir a Caja y Turnos',
        },
      },
    ];
  }

  private async detectExpiringQuotes(
    businessId: string,
    createdByIdOnly: string | undefined,
    now: Date,
  ): Promise<SystemNotificationItem[]> {
    const next3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const quotes = await this.prisma.posQuote.findMany({
      where: {
        businessId,
        status: 'SENT',
        expiresAt: {
          gt: now,
          lte: next3Days,
        },
        ...(createdByIdOnly ? { createdById: createdByIdOnly } : {}),
      },
      select: {
        id: true,
        quoteNumber: true,
        customerName: true,
        total: true,
        currency: true,
        expiresAt: true,
      },
      orderBy: { expiresAt: 'asc' },
    });

    if (quotes.length === 0) return [];

    return [
      {
        id: 'QUOTES_EXPIRING_SOON',
        fingerprint: `QUOTES_EXPIRING_SOON:${quotes.length}:${quotes[0].id}`,
        category: 'OPERATIONS',
        severity: 'INFO',
        title: `${quotes.length} ${quotes.length === 1 ? 'proforma emitida por vencer' : 'proformas emitidas por vencer'}`,
        body: `Vencen en los próximos 3 días. Podés darles seguimiento antes de que expiren.`,
        count: quotes.length,
        highlights: quotes
          .slice(0, 3)
          .map((q) => `${q.quoteNumber} · ${q.customerName || 'Sin cliente'}`),
        redirect: {
          route: '/quotes',
          state: { statusFilter: 'SENT' },
          actionLabel: 'Ver proformas emitidas',
        },
      },
    ];
  }
}
