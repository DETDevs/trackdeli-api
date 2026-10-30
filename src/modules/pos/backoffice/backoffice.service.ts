import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { BusinessProductType, Prisma, SaleStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  resolveBusinessDateRange,
  buildBusinessDateRange,
  DEFAULT_BUSINESS_TIMEZONE,
} from '../../../common/utils/date.util';
import { ReportsService } from '../reports/reports.service';
import { BatchesService } from '../batches/batches.service';
import { BusinessProductsService } from '../../business-products/business-products.service';
import { getSalePaymentBreakdown } from '../cash-register/pos-cash.utils';
import {
  BackofficeSalesQueryDto,
  BackofficeDateRangeDto,
  BackofficeInventoryQueryDto,
  BackofficeCashRegisterQueryDto,
} from './dto/backoffice-query.dto';

@Injectable()
export class BackofficeService {
  private readonly logger = new Logger(BackofficeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reportsService: ReportsService,
    private readonly batchesService: BatchesService,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  private round2(num: number): number {
    return Math.round((num + Number.EPSILON) * 100) / 100;
  }

  private buildDateRange(from?: string, to?: string) {
    return buildBusinessDateRange(from, to);
  }

  private extractPlaca(vehicleInfo?: string | null): string | null {
    if (!vehicleInfo) return null;
    const match = vehicleInfo.match(/placa:\s*([^,\-\n]+)/i);
    if (match && match[1]) {
      return match[1].trim();
    }
    return vehicleInfo.split('-')[0].trim() || null;
  }

  /**
   * 1. Resumen (Dashboard)
   * Ventas de hoy, de la semana y del mes (total C$ y cantidad), ticket promedio,
   * comparación contra el período anterior, y métodos de pago (efectivo/tarjeta/transferencia).
   * Ampliado (204a) con caja abierta, ganancia de hoy, últimas 5 ventas, alertas del negocio,
   * agregación en base de datos para paymentMethods y zona horaria de Managua.
   */
  async getDashboard(businessId: string, branchId?: string) {
    // Rangos en zona horaria del negocio (por defecto 'America/Managua')
    const todayRange = resolveBusinessDateRange({ period: 'today' });
    const weekRange = resolveBusinessDateRange({ period: 'last7days' });
    const monthRange = resolveBusinessDateRange({ period: 'month' });

    const todayStart = todayRange.startDate;
    const todayEnd = todayRange.endDate;
    const yesterdayStart = todayRange.previous!.startDate;
    const yesterdayEnd = todayRange.previous!.endDate;

    const weekStart = weekRange.startDate;
    const weekEnd = weekRange.endDate;
    const prevWeekStart = weekRange.previous!.startDate;
    const prevWeekEnd = weekRange.previous!.endDate;

    const monthStart = monthRange.startDate;
    const monthEnd = monthRange.endDate;
    const prevMonthStart = monthRange.previous!.startDate;
    const prevMonthEnd = monthRange.previous!.endDate;

    // Helper para calcular métricas de un rango con agregación en BD
    const computePeriodMetrics = async (startDate: Date, endDate: Date) => {
      const rows: any[] = await this.prisma.$queryRaw`
        SELECT
          COUNT(*)::int AS "salesCount",
          COALESCE(SUM(GREATEST(0, s.total - COALESCE(ret.refund_total, 0))), 0)::float AS "totalRevenue",
          COALESCE(SUM(
            CASE
              WHEN s."taxModel" = 'PER_LINE' THEN (
                SELECT COALESCE(SUM(si."subtotal" - si."manualDiscountShare"), 0)
                FROM pos_sale_items si
                WHERE si."saleId" = s.id AND si.taxable = true
              )
              WHEN s."taxModel" = 'LEGACY' AND s."taxAmount" > 0 THEN GREATEST(0, s.subtotal - s."discountAmount")
              ELSE 0
            END
          ), 0)::float AS "taxableSales",
          COALESCE(SUM(
            CASE
              WHEN s."taxModel" = 'PER_LINE' THEN (
                SELECT COALESCE(SUM(si."subtotal" - si."manualDiscountShare"), 0)
                FROM pos_sale_items si
                WHERE si."saleId" = s.id AND (si.taxable = false OR si.taxable IS NULL)
              )
              WHEN s."taxModel" = 'LEGACY' AND (s."taxAmount" = 0 OR s."taxAmount" IS NULL) THEN GREATEST(0, s.subtotal - s."discountAmount")
              ELSE 0
            END
          ), 0)::float AS "exemptSales",
          COALESCE(SUM(GREATEST(0, s."taxAmount" - COALESCE(ret.tax_refund, 0))), 0)::float AS "taxAmount"
        FROM pos_sales s
        LEFT JOIN (
          SELECT "saleId",
            SUM("refundAmount") AS refund_total,
            SUM(COALESCE("taxRefunded", 0)) AS tax_refund
          FROM pos_sale_returns
          GROUP BY "saleId"
        ) ret ON ret."saleId" = s.id
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
          ${branchId ? Prisma.sql`AND (s."posTerminalId" = ${branchId} OR s."cashRegisterId" = ${branchId})` : Prisma.empty}
      `;

      const salesCount = Number(rows[0]?.salesCount || 0);
      const totalRevenue = this.round2(Number(rows[0]?.totalRevenue || 0));
      const taxableSales = this.round2(Number(rows[0]?.taxableSales || 0));
      const exemptSales = this.round2(Number(rows[0]?.exemptSales || 0));
      const taxAmount = this.round2(Number(rows[0]?.taxAmount || 0));
      const averageTicket = salesCount > 0 ? this.round2(totalRevenue / salesCount) : 0;
      return { totalRevenue, salesCount, averageTicket, taxableSales, exemptSales, taxAmount };
    };

    // Calcular crecimiento/comparación
    const computeComparison = (
      current: { totalRevenue: number; salesCount: number; averageTicket: number },
      prev: { totalRevenue: number; salesCount: number; averageTicket: number },
    ) => {
      const revenueDiff = this.round2(current.totalRevenue - prev.totalRevenue);
      const revenueGrowthPercent = prev.totalRevenue > 0
        ? this.round2(((current.totalRevenue - prev.totalRevenue) / prev.totalRevenue) * 100)
        : (current.totalRevenue > 0 ? 100 : 0);

      const salesCountDiff = current.salesCount - prev.salesCount;
      const salesGrowthPercent = prev.salesCount > 0
        ? this.round2(((current.salesCount - prev.salesCount) / prev.salesCount) * 100)
        : (current.salesCount > 0 ? 100 : 0);

      return {
        revenueDiff,
        revenueGrowthPercent,
        salesCountDiff,
        salesGrowthPercent,
      };
    };

    // Agregación de métodos de pago en base de datos (sin cargar ventas en memoria)
    const computePaymentMethods = async () => {
      const pmRows: any[] = await this.prisma.$queryRaw`
        WITH month_sales AS (
          SELECT
            s.id,
            s.total,
            s."paymentMethod",
            COALESCE(ret.refund_total, 0) AS refund_total
          FROM pos_sales s
          LEFT JOIN (
            SELECT "saleId", SUM("refundAmount") AS refund_total
            FROM pos_sale_returns
            GROUP BY "saleId"
          ) ret ON ret."saleId" = s.id
          WHERE s."businessId" = ${businessId}
            AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
            AND s."createdAt" >= ${monthStart} AND s."createdAt" <= ${monthEnd}
            ${branchId ? Prisma.sql`AND (s."posTerminalId" = ${branchId} OR s."cashRegisterId" = ${branchId})` : Prisma.empty}
        ),
        sales_with_payments AS (
          SELECT DISTINCT p."saleId"
          FROM pos_payments p
          JOIN month_sales ms ON ms.id = p."saleId"
        ),
        payments_agg AS (
          SELECT
            UPPER(COALESCE(p.method::text, '')) AS method,
            SUM(
              COALESCE(
                CASE WHEN p."amountBase" IS NOT NULL AND p."amountBase" > 0 THEN p."amountBase" ELSE p.amount END,
                0
              )
            ) AS amount
          FROM pos_payments p
          JOIN month_sales ms ON ms.id = p."saleId"
          GROUP BY UPPER(COALESCE(p.method::text, ''))
        ),
        direct_sales_agg AS (
          SELECT
            UPPER(COALESCE(ms."paymentMethod"::text, '')) AS method,
            SUM(GREATEST(0, ms.total - ms.refund_total)) AS amount
          FROM month_sales ms
          WHERE ms.id NOT IN (SELECT "saleId" FROM sales_with_payments)
          GROUP BY UPPER(COALESCE(ms."paymentMethod"::text, ''))
        ),
        combined AS (
          SELECT method, amount FROM payments_agg
          UNION ALL
          SELECT method, amount FROM direct_sales_agg
        )
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE method IN ('EFECTIVO', 'CASH')), 0)::float AS efectivo,
          COALESCE(SUM(amount) FILTER (WHERE method IN ('TARJETA', 'CARD')), 0)::float AS tarjeta,
          COALESCE(SUM(amount) FILTER (WHERE method IN ('TRANSFERENCIA', 'TRANSFER')), 0)::float AS transferencia,
          COALESCE(SUM(amount) FILTER (WHERE method NOT IN ('EFECTIVO', 'CASH', 'TARJETA', 'CARD', 'TRANSFERENCIA', 'TRANSFER')), 0)::float AS otros
        FROM combined;
      `;

      return {
        efectivo: this.round2(Number(pmRows[0]?.efectivo || 0)),
        tarjeta: this.round2(Number(pmRows[0]?.tarjeta || 0)),
        transferencia: this.round2(Number(pmRows[0]?.transferencia || 0)),
        otros: this.round2(Number(pmRows[0]?.otros || 0)),
      };
    };

    // Cajas abiertas: id, cashierName, openedAt, openingFloat, expectedCash, salesCount
    const computeOpenRegisters = async () => {
      const openRegs = await this.prisma.cashRegister.findMany({
        where: {
          businessId,
          status: 'OPEN',
          ...(branchId ? { id: branchId } : {}),
        },
        include: {
          cashier: { select: { id: true, name: true } },
          movements: true,
          sales: {
            where: { status: { notIn: [SaleStatus.CANCELLED, SaleStatus.VOIDED] } },
            include: { payments: true, returns: { select: { refundAmount: true, refundMethod: true } } },
          },
        },
        orderBy: { openedAt: 'desc' },
      });

      const formatted = openRegs.map((reg) => {
        const openingFloat = this.round2(Number(reg.openingCash ?? 0));
        let decMovementsIn = new Prisma.Decimal(0);
        let decMovementsOut = new Prisma.Decimal(0);

        for (const m of reg.movements || []) {
          const amt = new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0);
          const isUsd = (m.currency || '').toUpperCase() === 'USD';
          const type = m.type === 'SALIDA' ? 'OUT' : (m.type === 'ENTRADA' ? 'IN' : m.type);
          if (!isUsd) {
            if (type === 'IN') decMovementsIn = decMovementsIn.plus(amt);
            if (type === 'OUT') decMovementsOut = decMovementsOut.plus(amt);
          }
        }

        let decCash = new Prisma.Decimal(0);
        let activeSalesCount = 0;

        for (const s of reg.sales || []) {
          activeSalesCount++;
          const breakdown = getSalePaymentBreakdown(s);
          decCash = decCash.plus(new Prisma.Decimal(breakdown.cashNio));
        }

        const liveExpectedCash = new Prisma.Decimal(openingFloat)
          .plus(decCash)
          .plus(decMovementsIn)
          .minus(decMovementsOut);

        const expectedCash = reg.expectedCash != null
          ? this.round2(Number(reg.expectedCash))
          : this.round2(Number(liveExpectedCash));

        return {
          id: reg.id,
          cashierName: reg.cashier?.name || 'Desconocido',
          openedAt: reg.openedAt,
          openingFloat,
          expectedCash,
          salesCount: activeSalesCount,
        };
      });

      return {
        openRegister: formatted.length > 0 ? formatted[0] : null,
        openRegisters: formatted,
      };
    };

    // Ganancias de hoy: { profit, cost, marginPct, itemsWithoutCost }
    const computeTodayProfit = async () => {
      try {
        const profitData = await this.reportsService.getProfit(businessId, 'today');
        return {
          profit: this.round2(Number(profitData.estimatedProfit ?? 0)),
          cost: this.round2(Number(profitData.totalCost ?? 0)),
          marginPct: Number(profitData.marginPercent ?? 0),
          itemsWithoutCost: Number(profitData.missingCostCount ?? 0),
        };
      } catch (err) {
        this.logger.warn(`Could not compute todayProfit: ${err.message}`);
        return {
          profit: 0,
          cost: 0,
          marginPct: 0,
          itemsWithoutCost: 0,
        };
      }
    };

    // Últimas 5 ventas: invoiceNumber, createdAt, total, paymentMethod, status
    const computeLastSales = async () => {
      const sales = await this.prisma.sale.findMany({
        where: {
          businessId,
          ...(branchId ? { OR: [{ posTerminalId: branchId }, { cashRegisterId: branchId }] } : {}),
        },
        select: {
          id: true,
          invoiceNumber: true,
          createdAt: true,
          total: true,
          paymentMethod: true,
          status: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });

      return sales.map((s) => ({
        id: s.id,
        invoiceNumber: s.invoiceNumber,
        createdAt: s.createdAt,
        total: this.round2(s.total),
        paymentMethod: s.paymentMethod,
        status: s.status,
      }));
    };

    // Alertas (stock, lotes, créditos vencidos, última diferencia de caja)
    const computeAlerts = async (tracksBatches: boolean) => {
      const alerts: Record<string, any> = {};

      // 1. lowStock & outOfStock
      try {
        const stockRows: any[] = await this.prisma.$queryRaw`
          SELECT
            COUNT(*) FILTER (WHERE stock <= 0)::int AS "outOfStockCount",
            COUNT(*) FILTER (WHERE stock > 0 AND stock <= "minStock")::int AS "lowStockCount"
          FROM pos_products
          WHERE "businessId" = ${businessId}
            AND "isActive" = true
            AND "trackStock" = true
        `;
        alerts.lowStock = { count: Number(stockRows[0]?.lowStockCount || 0) };
        alerts.outOfStock = { count: Number(stockRows[0]?.outOfStockCount || 0) };
      } catch (err) {
        this.logger.warn(`Could not compute stock alerts: ${err.message}`);
        alerts.lowStock = { count: 0 };
        alerts.outOfStock = { count: 0 };
      }

      // 2. expiringBatches y expiredBatches: solo si tracksBatches
      if (tracksBatches) {
        try {
          const batchExp = await this.batchesService.getExpiringBatches(businessId, 30);
          alerts.expiringBatches = {
            count: Number(batchExp.summary?.criticos?.count || 0),
            amount: this.round2(Number(batchExp.summary?.criticos?.valueAtRisk || 0)),
          };
          alerts.expiredBatches = {
            count: Number(batchExp.summary?.vencidos?.count || 0),
            amount: this.round2(Number(batchExp.summary?.vencidos?.valueAtRisk || 0)),
          };
        } catch (err) {
          this.logger.warn(`Could not compute batch alerts: ${err.message}`);
        }
      }

      // 3. overdueCredit: solo si el negocio tiene el add-on de Finanzas/Cartera
      try {
        const isCarteraActive = await this.businessProductsService.isActive(
          businessId,
          BusinessProductType.CARTERA_COBRO,
        );
        if (isCarteraActive) {
          const creditRows: any[] = await this.prisma.$queryRaw`
            SELECT
              COUNT(*)::int AS count,
              COALESCE(SUM(balance), 0)::float AS amount
            FROM pos_credit_accounts
            WHERE "businessId" = ${businessId}
              AND status NOT IN ('PAID', 'CANCELLED')
              AND (status = 'OVERDUE' OR "dueDate" < NOW())
          `;
          alerts.overdueCredit = {
            count: Number(creditRows[0]?.count || 0),
            amount: this.round2(Number(creditRows[0]?.amount || 0)),
          };
        }
      } catch (err) {
        this.logger.warn(`Could not compute credit alerts: ${err.message}`);
      }

      // 4. lastCashDifference: última diferencia != 0 en los últimos 7 días
      try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const diffRows: any[] = await this.prisma.$queryRaw`
          SELECT
            r.id,
            r.difference::float AS amount,
            r."closedAt" AS date,
            u.name AS "cashierName"
          FROM pos_cash_registers r
          LEFT JOIN users u ON u.id = r."cashierId"
          WHERE r."businessId" = ${businessId}
            AND r.status = 'CLOSED'
            AND r."closedAt" >= ${sevenDaysAgo}
            AND r.difference IS NOT NULL
            AND r.difference != 0
          ORDER BY r."closedAt" DESC
          LIMIT 1
        `;
        alerts.lastCashDifference = diffRows.length > 0 ? {
          amount: this.round2(Number(diffRows[0].amount)),
          cashier: diffRows[0].cashierName || 'Desconocido',
          date: diffRows[0].date,
        } : null;
      } catch (err) {
        this.logger.warn(`Could not compute cash difference alert: ${err.message}`);
        alerts.lastCashDifference = null;
      }

      return alerts;
    };

    // Obtener información base del negocio
    const [business, posSub] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { currency: true, salonProfile: true, tracksBatches: true },
      }),
      this.prisma.businessProductSubscription.findFirst({
        where: { businessId, productType: BusinessProductType.POS },
        select: { backofficeTier: true as any },
      }),
    ]);

    // Ejecutar consultas en paralelo
    const [
      todayMetrics,
      yesterdayMetrics,
      weekMetrics,
      prevWeekMetrics,
      monthMetrics,
      prevMonthMetrics,
      paymentMethods,
      { openRegister, openRegisters },
      todayProfit,
      lastSales,
      alerts,
    ] = await Promise.all([
      computePeriodMetrics(todayStart, todayEnd),
      computePeriodMetrics(yesterdayStart, yesterdayEnd),
      computePeriodMetrics(weekStart, weekEnd),
      computePeriodMetrics(prevWeekStart, prevWeekEnd),
      computePeriodMetrics(monthStart, monthEnd),
      computePeriodMetrics(prevMonthStart, prevMonthEnd),
      computePaymentMethods(),
      computeOpenRegisters(),
      computeTodayProfit(),
      computeLastSales(),
      computeAlerts(!!business?.tracksBatches),
    ]);

    return {
      tier: (posSub as any)?.backofficeTier || 'BASIC',
      currency: business?.currency || 'NIO',
      salonProfile: business?.salonProfile || 'RESTAURANTE',
      today: {
        ...todayMetrics,
        previousPeriod: yesterdayMetrics,
        comparison: computeComparison(todayMetrics, yesterdayMetrics),
      },
      week: {
        ...weekMetrics,
        previousPeriod: prevWeekMetrics,
        comparison: computeComparison(weekMetrics, prevWeekMetrics),
      },
      month: {
        ...monthMetrics,
        previousPeriod: prevMonthMetrics,
        comparison: computeComparison(monthMetrics, prevMonthMetrics),
      },
      paymentMethods,
      openRegister,
      openRegisters,
      todayProfit,
      lastSales,
      alerts,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_BUSINESS_TIMEZONE,
    };
  }

  /**
   * 2. Ventas (listado paginado con filtros)
   * Filtros por rango de fechas, método de pago, usuario/cajero y sucursal.
   * Excluir o marcar anuladas.
   */
  async getSales(businessId: string, query: BackofficeSalesQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.SaleWhereInput = { businessId };

    const dateRange = this.buildDateRange(query.from, query.to);
    if (Object.keys(dateRange).length > 0) {
      where.createdAt = dateRange;
    }

    if (query.paymentMethod) {
      where.paymentMethod = query.paymentMethod as any;
    }

    if (query.bankId) {
      where.payments = { some: { bankId: query.bankId } };
    }

    if (query.cashierId) {
      where.cashierId = query.cashierId;
    }

    if (query.branchId) {
      where.OR = [
        { posTerminalId: query.branchId },
        { cashRegisterId: query.branchId },
      ];
    }

    if (query.status) {
      if (query.status === 'CANCELLED' || query.status === 'VOIDED') {
        where.status = { in: [SaleStatus.CANCELLED, SaleStatus.VOIDED] };
      } else {
        where.status = query.status as any;
      }
    } else if (query.excludeVoided) {
      where.status = { notIn: [SaleStatus.CANCELLED, SaleStatus.VOIDED] };
    }

    const [total, sales] = await Promise.all([
      this.prisma.sale.count({ where }),
      this.prisma.sale.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          cashier: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true, phone: true, ruc: true } },
          returns: { select: { refundAmount: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);

    const data = sales.map((sale) => {
      const isVoided = sale.status === SaleStatus.CANCELLED || sale.status === SaleStatus.VOIDED;
      const refundTotal = (sale.returns || []).reduce((acc, r) => acc + (r.refundAmount || 0), 0);
      const netTotal = Math.max(0, sale.total - refundTotal);

      return {
        id: sale.id,
        invoiceNumber: sale.invoiceNumber,
        invoiceDate: sale.invoiceDate,
        createdAt: sale.createdAt,
        status: sale.status,
        isVoided,
        voidReason: sale.voidReason || null,
        voidedAt: sale.voidedAt || null,
        paymentMethod: sale.paymentMethod,
        subtotal: this.round2(sale.subtotal),
        discountAmount: this.round2(sale.discountAmount),
        taxAmount: this.round2(sale.taxAmount),
        total: this.round2(sale.total),
        netTotal: this.round2(netTotal),
        amountPaid: this.round2(sale.amountPaid),
        change: Number(new Prisma.Decimal(sale.change.toString()).toDecimalPlaces(2)),
        itemsCount: sale._count.items,
        cashier: sale.cashier ? { id: sale.cashier.id, name: sale.cashier.name } : null,
        customer: {
          id: sale.customerId,
          name: sale.customerName || sale.customer?.name || null,
          phone: sale.customerPhone || sale.customer?.phone || null,
          ruc: sale.customerRuc || sale.customer?.ruc || null,
        },
        taller: {
          placa: this.extractPlaca(sale.vehicleInfo),
          vehiculo: sale.vehicleInfo || null,
          tecnico: sale.waiterName || null,
          area: sale.zoneName || sale.tableNumber || null,
        },
      };
    });

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * 2b. Detalle de una venta
   * Ítems, cliente, y en perfil TALLER: placa, vehículo, técnico, área.
   */
  async getSaleDetail(businessId: string, saleId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
      include: {
        cashier: { select: { id: true, name: true, email: true } },
        customer: { select: { id: true, name: true, phone: true, ruc: true, email: true } },
        cashRegister: { select: { id: true, openedAt: true, closedAt: true, status: true } },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                barcode: true,
                sku: true,
                unit: true,
                category: { select: { id: true, name: true } },
              },
            },
          },
        },
        payments: true,
        returns: {
          include: {
            items: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!sale) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'SALE_NOT_FOUND',
        message: 'Venta no encontrada',
      });
    }

    const isVoided = sale.status === SaleStatus.CANCELLED || sale.status === SaleStatus.VOIDED;
    const totalRefunded = (sale.returns || []).reduce((acc, r) => acc + (r.refundAmount || 0), 0);
    const netTotal = Math.max(0, sale.total - totalRefunded);

    return {
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      invoiceDate: sale.invoiceDate,
      createdAt: sale.createdAt,
      status: sale.status,
      isVoided,
      voidReason: sale.voidReason || null,
      voidedAt: sale.voidedAt || null,
      paymentMethod: sale.paymentMethod,
      subtotal: this.round2(sale.subtotal),
      discountAmount: this.round2(sale.discountAmount),
      taxRate: sale.taxRate,
      taxAmount: this.round2(sale.taxAmount),
      total: this.round2(sale.total),
      taxModel: (sale as any).taxModel || 'LEGACY',
      listPriceTotal: this.round2(Number((sale as any).listPriceTotal || 0)),
      listDiscountTotal: this.round2(Number((sale as any).listDiscountTotal || 0)),
      totalRefunded: this.round2(totalRefunded),
      netTotal: this.round2(netTotal),
      amountPaid: this.round2(sale.amountPaid),
      change: Number(new Prisma.Decimal(sale.change.toString()).toDecimalPlaces(2)),
      notes: sale.notes || null,
      cashier: sale.cashier ? { id: sale.cashier.id, name: sale.cashier.name, email: sale.cashier.email } : null,
      cashRegister: sale.cashRegister,
      customer: {
        id: sale.customerId,
        name: sale.customerName || sale.customer?.name || null,
        phone: sale.customerPhone || sale.customer?.phone || null,
        ruc: sale.customerRuc || sale.customer?.ruc || null,
        email: sale.customer?.email || null,
      },
      taller: {
        placa: this.extractPlaca(sale.vehicleInfo),
        vehiculo: sale.vehicleInfo || null,
        tecnico: sale.waiterName || null,
        area: sale.zoneName || sale.tableNumber || null,
      },
      items: sale.items.map((item) => {
        const returnedQty = item.returnedQty != null ? Number(item.returnedQty) : 0;
        const netQty = Math.max(0, item.quantity - returnedQty);
        return {
          id: item.id,
          productId: item.productId,
          productName: item.productName,
          barcode: item.product?.barcode || null,
          sku: item.product?.sku || null,
          category: item.product?.category?.name || 'Sin categoría',
          unit: item.product?.unit || 'UND',
          unitPrice: this.round2(item.unitPrice),
          quantity: item.quantity,
          returnedQty,
          netQuantity: netQty,
          subtotal: this.round2(item.subtotal),
          total: this.round2(item.subtotal),
          discount: item.discount,
          listPrice: (item as any).listPrice != null ? this.round2(Number((item as any).listPrice)) : null,
          listPriceDiscount: this.round2(Number((item as any).listPriceDiscount || 0)),
          manualDiscountShare: this.round2(Number((item as any).manualDiscountShare || 0)),
          taxable: (item as any).taxable ?? false,
          taxRate: (item as any).taxRate ?? 0,
          taxAmount: this.round2(Number((item as any).taxAmount || 0)),
        };
      }),
      returns: sale.returns.map((r) => ({
        id: r.id,
        returnNumber: r.returnNumber,
        refundAmount: this.round2(r.refundAmount),
        refundMethod: r.refundMethod,
        reason: r.reason,
        createdAt: r.createdAt,
        itemsCount: r.items?.length || 0,
      })),
      payments: sale.payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: this.round2(Number(p.amount)),
        currency: p.currency,
        exchangeRate: Number(p.exchangeRate),
        amountBase: this.round2(Number(p.amountBase)),
      })),
    };
  }

  /**
   * 3. Productos más vendidos por rango de fechas (cantidad e ingreso)
   */
  async getTopProducts(businessId: string, query: BackofficeDateRangeDto) {
    const limit = Math.max(1, Number(query.limit) || 10);
    const dateRange = this.buildDateRange(query.from, query.to);

    const saleWhere: Prisma.SaleWhereInput = {
      businessId,
      status: { in: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_RETURNED, SaleStatus.RETURNED] },
    };
    if (Object.keys(dateRange).length > 0) {
      saleWhere.createdAt = dateRange;
    }

    const items = await this.prisma.saleItem.findMany({
      where: { sale: saleWhere },
      include: {
        product: { select: { id: true, name: true, barcode: true, category: { select: { name: true } } } },
      },
    });

    const productMap = new Map<string, {
      productId: string | null;
      productName: string;
      barcode: string | null;
      category: string;
      quantity: number;
      revenue: number;
      timesSold: number;
    }>();

    for (const item of items) {
      const netQty = Math.max(0, item.quantity - (item.returnedQty || 0));
      if (netQty <= 0) continue;

      const key = item.productId || item.productName;
      const existing = productMap.get(key) || {
        productId: item.productId || null,
        productName: item.productName,
        barcode: item.product?.barcode || null,
        category: item.product?.category?.name || 'Sin categoría',
        quantity: 0,
        revenue: 0,
        timesSold: 0,
      };

      existing.quantity += netQty;
      const unitEffective = item.quantity > 0 ? (item.subtotal / item.quantity) : item.unitPrice;
      existing.revenue += unitEffective * netQty;
      existing.timesSold += 1;
      productMap.set(key, existing);
    }

    return Array.from(productMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit)
      .map((p) => ({
        ...p,
        quantity: this.round2(p.quantity),
        revenue: this.round2(p.revenue),
      }));
  }

  /**
   * 3b. Ventas por categoría por rango de fechas
   */
  async getSalesByCategory(businessId: string, query: BackofficeDateRangeDto) {
    const dateRange = this.buildDateRange(query.from, query.to);

    const saleWhere: Prisma.SaleWhereInput = {
      businessId,
      status: { in: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_RETURNED, SaleStatus.RETURNED] },
    };
    if (Object.keys(dateRange).length > 0) {
      saleWhere.createdAt = dateRange;
    }

    const items = await this.prisma.saleItem.findMany({
      where: { sale: saleWhere },
      include: {
        product: { select: { categoryId: true, category: { select: { id: true, name: true } } } },
      },
    });

    const categoryMap = new Map<string, {
      categoryId: string | null;
      categoryName: string;
      quantity: number;
      revenue: number;
      salesCount: number;
    }>();

    let totalRevenueGlobal = 0;

    for (const item of items) {
      const netQty = Math.max(0, item.quantity - (item.returnedQty || 0));
      if (netQty <= 0) continue;

      const categoryId = item.product?.category?.id || 'uncategorized';
      const categoryName = item.product?.category?.name || 'Sin categoría';

      const existing = categoryMap.get(categoryId) || {
        categoryId: categoryId === 'uncategorized' ? null : categoryId,
        categoryName,
        quantity: 0,
        revenue: 0,
        salesCount: 0,
      };

      const unitEffective = item.quantity > 0 ? (item.subtotal / item.quantity) : item.unitPrice;
      const itemRev = unitEffective * netQty;

      existing.quantity += netQty;
      existing.revenue += itemRev;
      existing.salesCount += 1;
      totalRevenueGlobal += itemRev;

      categoryMap.set(categoryId, existing);
    }

    const result = Array.from(categoryMap.values())
      .map((cat) => ({
        ...cat,
        quantity: this.round2(cat.quantity),
        revenue: this.round2(cat.revenue),
        percentage: totalRevenueGlobal > 0 ? this.round2((cat.revenue / totalRevenueGlobal) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    return {
      totalRevenue: this.round2(totalRevenueGlobal),
      categories: result,
    };
  }

  /**
   * 4. Inventario
   * Listado de productos con existencia, unidad, mínimo y estado (normal / bajo / agotado);
   * filtro "solo bajo mínimo". Los servicios (sin control de stock) no entran al alerta.
   */
  async getInventory(businessId: string, query: BackofficeInventoryQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));

    const where: Prisma.ProductWhereInput = {
      businessId,
      isActive: true,
    };

    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { barcode: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const products = await this.prisma.product.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    const mapped = products.map((p) => {
      const stock = Number(p.stock != null ? p.stock : 0);
      const minStock = Number(p.minStock != null ? p.minStock : 0);
      const isService = !p.trackStock;

      let status: 'normal' | 'bajo' | 'agotado' = 'normal';
      if (!isService) {
        if (stock <= 0) {
          status = 'agotado';
        } else if (stock <= minStock) {
          status = 'bajo';
        }
      }

      return {
        id: p.id,
        name: p.name,
        sku: p.sku || null,
        barcode: p.barcode || null,
        category: p.category ? { id: p.category.id, name: p.category.name } : null,
        stock,
        unit: p.unit || 'UND',
        minStock,
        maxStock: p.maxStock != null ? Number(p.maxStock) : null,
        trackStock: p.trackStock,
        isService,
        status,
        price: Number(p.price),
      };
    });

    // Filtro "solo bajo mínimo"
    const onlyLowStock = query.onlyLowStock || query.lowStock;
    const filtered = onlyLowStock
      ? mapped.filter((p) => !p.isService && (p.status === 'bajo' || p.status === 'agotado'))
      : mapped;

    const total = filtered.length;
    const paginated = filtered.slice((page - 1) * limit, page * limit);

    return {
      data: paginated,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * 5. Cierres de caja (listado)
   * Apertura, ventas, diferencias, quién cerró.
   */
  async getCashRegisters(businessId: string, query: BackofficeCashRegisterQueryDto) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.CashRegisterWhereInput = { businessId };

    const dateRange = this.buildDateRange(query.from, query.to);
    if (Object.keys(dateRange).length > 0) {
      where.openedAt = dateRange;
    }

    if (query.cashierId) {
      where.cashierId = query.cashierId;
    }

    const [total, registers] = await Promise.all([
      this.prisma.cashRegister.count({ where }),
      this.prisma.cashRegister.findMany({
        where,
        skip,
        take: limit,
        orderBy: { openedAt: 'desc' },
        include: {
          cashier: { select: { id: true, name: true } },
          sales: {
            where: { status: { in: [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_RETURNED, SaleStatus.RETURNED] } },
            select: { total: true, returns: { select: { refundAmount: true } } },
          },
          movements: true,
        },
      }),
    ]);

    const data = registers.map((reg) => {
      const isClosed = reg.status === 'CLOSED' || !!reg.closedAt;
      const initialAmount = Number(reg.openingCash ?? (reg as any).initialAmount ?? 0);
      const expectedCash = reg.expectedCash != null ? Number(reg.expectedCash) : initialAmount;
      const actualAmount = reg.closingCash != null ? Number(reg.closingCash) : null;
      const difference = reg.difference != null ? Number(reg.difference) : (actualAmount != null ? this.round2(actualAmount - expectedCash) : null);

      let totalSales = 0;
      for (const s of reg.sales) {
        const refundTotal = (s.returns || []).reduce((acc, r) => acc + (r.refundAmount || 0), 0);
        totalSales += Math.max(0, s.total - refundTotal);
      }

      return {
        id: reg.id,
        status: reg.status,
        openedAt: reg.openedAt,
        closedAt: reg.closedAt || null,
        openedBy: reg.cashier ? { id: reg.cashier.id, name: reg.cashier.name } : null,
        closedBy: isClosed ? (reg.cashier ? { id: reg.cashier.id, name: reg.cashier.name } : null) : null,
        openingCash: this.round2(initialAmount),
        expectedCash: this.round2(expectedCash),
        closingCash: actualAmount != null ? this.round2(actualAmount) : null,
        difference: difference != null ? this.round2(difference) : null,
        closingCashUsd: reg.closingCashUsd != null ? this.round2(Number(reg.closingCashUsd)) : null,
        differenceUsd: reg.differenceUsd != null ? this.round2(Number(reg.differenceUsd)) : null,
        totalSales: this.round2(totalSales),
        salesCount: reg.sales.length,
        notes: reg.notes || null,
      };
    });

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * 5b. Detalle de cierre de caja
   */
  async getCashRegisterDetail(businessId: string, registerId: string) {
    const reg = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId },
      include: {
        cashier: { select: { id: true, name: true, email: true } },
        movements: {
          include: { user: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        sales: {
          include: {
            returns: { select: { refundAmount: true } },
            payments: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!reg) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'REGISTER_NOT_FOUND',
        message: 'Caja no encontrada',
      });
    }

    const isClosed = reg.status === 'CLOSED' || !!reg.closedAt;
    const initialAmount = Number(reg.openingCash ?? (reg as any).initialAmount ?? 0);
    const expectedCash = reg.expectedCash != null ? Number(reg.expectedCash) : initialAmount;
    const actualAmount = reg.closingCash != null ? Number(reg.closingCash) : null;
    const difference = reg.difference != null ? Number(reg.difference) : (actualAmount != null ? this.round2(actualAmount - expectedCash) : null);

    let totalSales = 0;
    let totalCash = 0;
    let totalCard = 0;
    let totalTransfer = 0;

    for (const s of reg.sales) {
      if (s.status === SaleStatus.CANCELLED || s.status === SaleStatus.VOIDED) continue;
      const refundTotal = (s.returns || []).reduce((acc, r) => acc + (r.refundAmount || 0), 0);
      const netTotal = Math.max(0, s.total - refundTotal);
      totalSales += netTotal;

      if (s.payments && s.payments.length > 0) {
        for (const p of s.payments) {
          const method = (p.method || '').toUpperCase();
          const amt = Number(p.amountBase || p.amount || 0);
          if (method === 'EFECTIVO' || method === 'CASH') totalCash += amt;
          else if (method === 'TARJETA' || method === 'CARD') totalCard += amt;
          else if (method === 'TRANSFERENCIA' || method === 'TRANSFER') totalTransfer += amt;
        }
      } else {
        const method = (s.paymentMethod || '').toUpperCase();
        if (method === 'EFECTIVO' || method === 'CASH') totalCash += netTotal;
        else if (method === 'TARJETA' || method === 'CARD') totalCard += netTotal;
        else if (method === 'TRANSFERENCIA' || method === 'TRANSFER') totalTransfer += netTotal;
      }
    }

    return {
      id: reg.id,
      status: reg.status,
      openedAt: reg.openedAt,
      closedAt: reg.closedAt || null,
      openedBy: reg.cashier ? { id: reg.cashier.id, name: reg.cashier.name } : null,
      closedBy: isClosed ? (reg.cashier ? { id: reg.cashier.id, name: reg.cashier.name } : null) : null,
      openingCash: this.round2(initialAmount),
      expectedCash: this.round2(expectedCash),
      closingCash: actualAmount != null ? this.round2(actualAmount) : null,
      difference: difference != null ? this.round2(difference) : null,
      closingCashUsd: reg.closingCashUsd != null ? this.round2(Number(reg.closingCashUsd)) : null,
      differenceUsd: reg.differenceUsd != null ? this.round2(Number(reg.differenceUsd)) : null,
      totalSales: this.round2(totalSales),
      totalCash: this.round2(totalCash),
      totalCard: this.round2(totalCard),
      totalTransfer: this.round2(totalTransfer),
      salesCount: reg.sales.length,
      notes: reg.notes || null,
      movements: reg.movements.map((m) => ({
        id: m.id,
        type: m.type,
        amount: this.round2(Number(m.amount)),
        currency: m.currency || 'NIO',
        concept: m.concept || null,
        user: m.user ? { id: m.user.id, name: m.user.name } : null,
        createdAt: m.createdAt,
      })),
      sales: reg.sales.map((s) => ({
        id: s.id,
        invoiceNumber: s.invoiceNumber,
        createdAt: s.createdAt,
        total: this.round2(s.total),
        paymentMethod: s.paymentMethod,
        customerName: s.customerName || null,
        status: s.status,
      })),
    };
  }
}
