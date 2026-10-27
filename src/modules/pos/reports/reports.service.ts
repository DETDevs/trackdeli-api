import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { BusinessProductType, CreditAccountStatus, PosPaymentMethod, Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { BusinessProductsService } from "../../business-products/business-products.service";
import {
  resolveBusinessDateRange,
  buildBusinessDateRange,
  getHourInTimezone,
  DEFAULT_BUSINESS_TIMEZONE,
} from "../../../common/utils/date.util";

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  /**
   * Única resolución de costo por producto (usar con `WITH RECURSIVE`).
   * Prioridad: PRODUCT_COST (cost cargado, 0 incluido) > RECIPE > LABOR > UNKNOWN.
   * - RECIPE es recursiva (tope de profundidad 5). Un componente usa su costo directo
   *   o, si no lo tiene, su propia receta. Si CUALQUIER hoja no tiene costo, el producto
   *   completo queda UNKNOWN (sin suma parcial), aunque sea servicio.
   * - LABOR (160d): solo `type = 'SERVICE'`, SIN receta y con cost nulo -> costo 0, cubierto.
   *   Nunca se decide por trackStock, categoría ni nombre.
   * - PURCHASE: no entra (no hay fuente de costo por compras en esta resolución).
   */
  private getCostResolutionSql(businessId: string) {
    return Prisma.sql`
      recipe_tree AS (
        SELECT rc."parentProductId" AS root_id, rc."componentProductId" AS node_id,
               rc.quantity::float AS mult, 1 AS depth
        FROM pos_product_components rc
        WHERE rc."businessId" = ${businessId}
        UNION ALL
        SELECT t.root_id, rc."componentProductId", t.mult * rc.quantity::float, t.depth + 1
        FROM recipe_tree t
        JOIN pos_products np ON np.id = t.node_id AND np.cost IS NULL
        JOIN pos_product_components rc ON rc."parentProductId" = t.node_id
        WHERE t.depth < 5
      ),
      recipe_summary AS (
        SELECT
          t.root_id,
          SUM(t.mult * np.cost)::float AS recipe_cost,
          BOOL_OR(np.cost IS NULL) AS has_missing
        FROM recipe_tree t
        JOIN pos_products np ON np.id = t.node_id
        WHERE np.cost IS NOT NULL
           OR t.depth >= 5
           OR NOT EXISTS (SELECT 1 FROM pos_product_components x WHERE x."parentProductId" = t.node_id)
        GROUP BY t.root_id
      ),
      product_costs AS (
        SELECT
          p.id AS product_id,
          CASE
            WHEN p.cost IS NOT NULL THEN 'PRODUCT_COST'
            WHEN rs.root_id IS NOT NULL AND rs.has_missing = false THEN 'RECIPE'
            WHEN p."type" = 'SERVICE' AND rs.root_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM pos_product_components x WHERE x."parentProductId" = p.id) THEN 'LABOR'
            ELSE 'UNKNOWN'
          END AS cost_source,
          CASE
            WHEN p.cost IS NOT NULL THEN p.cost::float
            WHEN rs.root_id IS NOT NULL AND rs.has_missing = false THEN rs.recipe_cost
            WHEN p."type" = 'SERVICE' AND rs.root_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM pos_product_components x WHERE x."parentProductId" = p.id) THEN 0::float
            ELSE NULL
          END AS unit_cost
        FROM pos_products p
        LEFT JOIN recipe_summary rs ON rs.root_id = p.id
        WHERE p."businessId" = ${businessId}
      )
    `;
  }

  private getProfitItemsSql(businessId: string, fromDt: Date, toDt: Date) {
    return Prisma.sql`
      item_sales AS (
        SELECT
          i."productId" AS product_id,
          i."productName" AS product_name,
          GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0))::float AS net_qty,
          (
            ((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))
            * (CASE WHEN s.subtotal > 0 THEN (1 - (s."discountAmount" / s.subtotal)) ELSE 1 END)
          )::float AS line_revenue,
          pc.unit_cost,
          COALESCE(pc.cost_source, 'UNKNOWN') AS cost_source,
          false AS is_orphan
        FROM pos_sale_items i
        JOIN pos_sales s ON s.id = i."saleId"
        LEFT JOIN product_costs pc ON pc.product_id = i."productId"
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND (s."createdAt" AT TIME ZONE 'UTC') >= ${fromDt} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${toDt}

        UNION ALL

        SELECT
          NULL AS product_id,
          'Sin categoría' AS product_name,
          1::float AS net_qty,
          GREATEST(0, s.subtotal - s."discountAmount" - COALESCE((
            SELECT SUM("refundAmount" - COALESCE("taxRefunded", 0))
            FROM pos_sale_returns r
            WHERE r."saleId" = s.id
          ), 0))::float AS line_revenue,
          NULL::float AS unit_cost,
          'UNKNOWN' AS cost_source,
          true AS is_orphan
        FROM pos_sales s
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND (s."createdAt" AT TIME ZONE 'UTC') >= ${fromDt} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${toDt}
          AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i."saleId" = s.id)
      )
    `;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  private async ensureCarteraActive(businessId: string) {
    const isCarteraActive = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CARTERA_COBRO,
    );
    if (!isCarteraActive) {
      throw new ForbiddenException('Este negocio no tiene Finanzas contratada');
    }
  }

  private buildDateRange(from?: string, to?: string) {
    return buildBusinessDateRange(from, to);
  }

  async getSalesSummary(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const summaryAgg: any[] = await this.prisma.$queryRaw`
      SELECT
        COUNT(s.id)::int AS "totalSales",
        COALESCE(SUM(GREATEST(0, s.total - COALESCE(refunds.total_refund, 0))), 0)::float AS "totalRevenue",
        COALESCE(SUM(s."discountAmount"), 0)::float AS "totalDiscount",
        COALESCE(SUM(GREATEST(0, s."taxAmount" - COALESCE(refunds.tax_refund, 0))), 0)::float AS "totalTax",
        COALESCE(SUM(GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))), 0)::float AS "netRevenue",
        COALESCE(SUM(
          CASE
            WHEN s."taxModel" = 'PER_LINE' THEN COALESCE(lines_breakdown.taxable_net, 0)
            WHEN s."taxEnabled" = true AND s."taxRate" > 0 THEN GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))
            ELSE 0
          END
        ), 0)::float AS "taxableSales",
        COALESCE(SUM(
          CASE
            WHEN s."taxModel" = 'PER_LINE' THEN COALESCE(lines_breakdown.exempt_net, 0)
            WHEN s."taxEnabled" = true AND s."taxRate" > 0 THEN 0
            ELSE GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))
          END
        ), 0)::float AS "exemptSales"
      FROM pos_sales s
      LEFT JOIN (
        SELECT "saleId", SUM("refundAmount") AS total_refund, SUM("taxRefunded") AS tax_refund, SUM("refundAmount" - COALESCE("taxRefunded", 0)) AS net_refund
        FROM pos_sale_returns
        WHERE "businessId" = ${businessId}
        GROUP BY "saleId"
      ) refunds ON refunds."saleId" = s.id
      LEFT JOIN (
        SELECT
          i."saleId",
          SUM(CASE WHEN i.taxable = true THEN GREATEST(0, (i.subtotal - i."manualDiscountShare") - COALESCE(ri.net_refund, 0)) ELSE 0 END) AS taxable_net,
          SUM(CASE WHEN i.taxable = false THEN GREATEST(0, (i.subtotal - i."manualDiscountShare") - COALESCE(ri.net_refund, 0)) ELSE 0 END) AS exempt_net
        FROM pos_sale_items i
        LEFT JOIN (
          SELECT "saleItemId", SUM("refundAmount" - COALESCE("taxAmount", 0)) AS net_refund
          FROM pos_sale_return_items
          GROUP BY "saleItemId"
        ) ri ON ri."saleItemId" = i.id
        GROUP BY i."saleId"
      ) lines_breakdown ON lines_breakdown."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0);
    `;

    const byPaymentMethodRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        s."paymentMethod",
        COALESCE(SUM(GREATEST(0, s.total - COALESCE(refunds.total_refund, 0))), 0)::float AS revenue
      FROM pos_sales s
      LEFT JOIN (
        SELECT "saleId", SUM("refundAmount") AS total_refund
        FROM pos_sale_returns
        WHERE "businessId" = ${businessId}
        GROUP BY "saleId"
      ) refunds ON refunds."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0)
      GROUP BY s."paymentMethod";
    `;

    const byDayRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        TO_CHAR((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua', 'YYYY-MM-DD') AS date,
        COUNT(s.id)::int AS count,
        COALESCE(SUM(GREATEST(0, s.total - COALESCE(refunds.total_refund, 0))), 0)::float AS revenue
      FROM pos_sales s
      LEFT JOIN (
        SELECT "saleId", SUM("refundAmount") AS total_refund
        FROM pos_sale_returns
        WHERE "businessId" = ${businessId}
        GROUP BY "saleId"
      ) refunds ON refunds."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0)
      GROUP BY TO_CHAR((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua', 'YYYY-MM-DD')
      ORDER BY date ASC;
    `;

    const byPaymentMethod: Record<string, number> = {};
    for (const r of byPaymentMethodRaw) {
      if (r.revenue > 0) {
        byPaymentMethod[r.paymentMethod] = Math.round(r.revenue * 100) / 100;
      }
    }

    const byDay = byDayRaw.map(r => ({
      date: r.date,
      count: r.count,
      revenue: Math.round(r.revenue * 100) / 100
    }));

    const totalSales = summaryAgg[0]?.totalSales || 0;
    const totalRevenue = summaryAgg[0]?.totalRevenue || 0;
    const totalDiscount = summaryAgg[0]?.totalDiscount || 0;
    const totalTax = summaryAgg[0]?.totalTax || 0;
    const netRevenue = summaryAgg[0]?.netRevenue || 0;
    const taxableSales = summaryAgg[0]?.taxableSales || 0;
    const exemptSales = summaryAgg[0]?.exemptSales || 0;

    this.logger.log(`[getSalesSummary] businessId=${businessId} ventas=${totalSales} total=${totalRevenue.toFixed(2)}`);

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      totalSales,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalDiscount: Math.round(totalDiscount * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      netRevenue: Math.round(netRevenue * 100) / 100,
      taxableSales: Math.round(taxableSales * 100) / 100,
      exemptSales: Math.round(exemptSales * 100) / 100,
      averageTicket: totalSales > 0 ? Math.round((totalRevenue / totalSales) * 100) / 100 : 0,
      byPaymentMethod,
      byDay,
    };
  }

  async getTopProducts(businessId: string, period?: string, from?: string, to?: string, limit = 10) {
    let startDate: Date;
    let endDate: Date;
    if (period || from || to) {
      const range = this.resolveDateRange(period, from, to);
      startDate = range.current.from;
      endDate = range.current.to;
    } else {
      startDate = new Date('2000-01-01');
      endDate = new Date('2100-01-01');
    }

    const topsRaw: any[] = await this.prisma.$queryRaw`
      WITH item_sales AS (
        SELECT
          i."productName",
          COALESCE(c.name, 'Sin categoría') AS category,
          GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0))::float AS quantity,
          ((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))::float AS revenue
        FROM pos_sale_items i
        JOIN pos_sales s ON s.id = i."saleId"
        LEFT JOIN pos_products p ON p.id = i."productId"
        LEFT JOIN pos_categories c ON c.id = p."categoryId"
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
      )
      SELECT
        "productName" AS name,
        category,
        SUM(quantity)::float AS quantity,
        SUM(revenue)::float AS revenue,
        COUNT(*)::int AS times
      FROM item_sales
      WHERE quantity > 0 OR revenue > 0
      GROUP BY "productName", category
      ORDER BY revenue DESC
      LIMIT ${limit};
    `;

    return topsRaw.map(p => ({
      name: p.name,
      category: p.category,
      quantity: Math.round(p.quantity * 100) / 100,
      revenue: Math.round(p.revenue * 100) / 100,
      times: p.times,
    }));
  }

  async getDaily(businessId: string) {
    const range = resolveBusinessDateRange({ period: 'today' });
    const start = range.startDate;
    const end = range.endDate;

    const sales = await this.prisma.sale.findMany({
      where: {
        businessId,
        status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] },
        createdAt: { gte: start, lte: end },
      },
      include: { returns: true },
    });

    const byHour = new Map<number, { count: number; revenue: number }>();
    for (let h = 0; h < 24; h++) byHour.set(h, { count: 0, revenue: 0 });

    for (const sale of sales) {
      const hour = getHourInTimezone(sale.createdAt, DEFAULT_BUSINESS_TIMEZONE);
      const existing = byHour.get(hour)!;
      const refundsTotal = (sale.returns || []).reduce((rSum: number, r: any) => rSum + r.refundAmount, 0);
      const netSaleTotal = Math.max(0, sale.total - refundsTotal);
      existing.count += 1;
      existing.revenue += netSaleTotal;
    }

    return Array.from(byHour.entries()).map(([hour, data]) => ({
      hour,
      count: data.count,
      revenue: Math.round(data.revenue * 100) / 100,
    }));
  }

  async getStockAlerts(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId, isActive: true, trackStock: true },
      include: { category: true },
    });
    return products
      .filter((p) => Number(p.stock) <= Number(p.minStock))
      .sort((a, b) => Number(a.stock) - Number(b.stock));
  }

  async getCashRegisters(businessId: string, from?: string, to?: string) {
    const where: any = { businessId, status: "CLOSED" };
    const dateRange = this.buildDateRange(from, to);
    if (Object.keys(dateRange).length) where.openedAt = dateRange;

    return this.prisma.cashRegister.findMany({
      where,
      include: { cashier: { select: { id: true, name: true } } },
      orderBy: { openedAt: "desc" },
      take: 100,
    });
  }

  async getCashMovements(businessId: string, from?: string, to?: string) {
    const where: any = { businessId };
    const dateRange = this.buildDateRange(from, to);
    if (Object.keys(dateRange).length) where.createdAt = dateRange;

    return this.prisma.cashMovement.findMany({
      where,
      include: {
        user: { select: { id: true, name: true } },
        cashRegister: { select: { id: true, openedAt: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  resolveDateRange(period?: string, from?: string, to?: string) {
    const range = resolveBusinessDateRange({ period, from, to });
    return {
      current: {
        from: range.startDate,
        to: range.endDate,
        fromIso: range.fromIso,
        toIso: range.toIso,
      },
      previous: {
        from: range.previous?.startDate ?? range.startDate,
        to: range.previous?.endDate ?? range.endDate,
        fromIso: range.previous?.fromIso ?? range.fromIso,
        toIso: range.previous?.toIso ?? range.toIso,
      },
    };
  }

  async getOverview(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const summary = await this.getSalesSummary(businessId, undefined, range.current.fromIso, range.current.toIso);
    const prevSummary = await this.getSalesSummary(businessId, undefined, range.previous.fromIso, range.previous.toIso);
    const topProducts = await this.getTopProducts(businessId, undefined, range.current.fromIso, range.current.toIso, 5);
    const lowStockProducts = await this.getStockAlerts(businessId);

    const totalCash = summary.byPaymentMethod['EFECTIVO'] || 0;
    const totalCard = summary.byPaymentMethod['TARJETA'] || 0;
    const totalTransfer = summary.byPaymentMethod['TRANSFERENCIA'] || 0;

    const calcChange = (cur: number, prev: number): number | null => {
      if (prev <= 0) return null;
      return Math.round(((cur - prev) / prev) * 10000) / 100;
    };

    return {
      totalSales: summary.totalRevenue,
      salesCount: summary.totalSales,
      averageTicket: summary.averageTicket,
      totalCash,
      totalCard,
      totalTransfer,
      taxableSales: summary.taxableSales,
      exemptSales: summary.exemptSales,
      totalTax: summary.totalTax,
      topProducts: topProducts.map(p => ({
        productId: p.name,
        productName: p.name,
        quantity: p.quantity,
        revenue: p.revenue,
      })),
      lowStockProducts,
      summary,
      comparison: {
        previousPeriod: {
          from: range.previous.fromIso,
          to: range.previous.toIso,
        },
        totalSales: {
          current: summary.totalRevenue,
          previous: prevSummary.totalRevenue,
          changePercent: calcChange(summary.totalRevenue, prevSummary.totalRevenue),
        },
        salesCount: {
          current: summary.totalSales,
          previous: prevSummary.totalSales,
          changePercent: calcChange(summary.totalSales, prevSummary.totalSales),
        },
        averageTicket: {
          current: summary.averageTicket,
          previous: prevSummary.averageTicket,
          changePercent: calcChange(summary.averageTicket, prevSummary.averageTicket),
        },
      },
    };
  }

  async getCreditOverdue(businessId: string) {
    await this.ensureCarteraActive(businessId);
    const now = new Date();
    const accounts = await this.prisma.creditAccount.findMany({
      where: {
        businessId,
        status: { notIn: [CreditAccountStatus.PAID, CreditAccountStatus.CANCELLED] },
        dueDate: { lt: now },
      },
      include: {
        customer: true,
        sale: { select: { id: true, invoiceNumber: true, total: true, createdAt: true } },
        installments: {
          orderBy: { installmentNumber: 'asc' },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    const customerMap = new Map<string, any>();
    let totalOverdue = 0;

    for (const acc of accounts) {
      totalOverdue += acc.balance;
      const daysOverdue = Math.max(
        0,
        Math.floor((now.getTime() - new Date(acc.dueDate).getTime()) / (1000 * 60 * 60 * 24)),
      );

      const formattedInstallments = (acc.installments && acc.installments.length > 0)
        ? acc.installments.map((inst: any) => ({
            ...inst,
            amount: Number(inst.amount),
            paidAmount: Number(inst.paidAmount),
          }))
        : [
            {
              id: `virtual-${acc.id}`,
              creditAccountId: acc.id,
              installmentNumber: 1,
              dueDate: acc.dueDate,
              amount: Number(acc.originalAmount),
              paidAmount: Math.max(0, Math.round((Number(acc.originalAmount) - Number(acc.balance)) * 100) / 100),
              status: acc.status,
              paidAt: acc.status === 'PAID' ? acc.updatedAt : null,
            },
          ];

      if (!customerMap.has(acc.customerId)) {
        customerMap.set(acc.customerId, {
          customer: {
            id: acc.customer.id,
            name: acc.customer.name,
            phone: acc.customer.phone,
            ruc: acc.customer.ruc,
          },
          totalOverdue: 0,
          accountsCount: 0,
          accounts: [],
        });
      }

      const custEntry = customerMap.get(acc.customerId);
      custEntry.totalOverdue = Math.round((custEntry.totalOverdue + acc.balance) * 100) / 100;
      custEntry.accountsCount++;
      custEntry.accounts.push({
        id: acc.id,
        invoiceNumber: acc.sale.invoiceNumber,
        originalAmount: Number(acc.originalAmount),
        balance: Number(acc.balance),
        dueDate: acc.dueDate,
        daysOverdue,
        status: acc.status,
        installments: formattedInstallments,
      });
    }

    return {
      totalOverdue: Math.round(totalOverdue * 100) / 100,
      overdueAccountsCount: accounts.length,
      customersCount: customerMap.size,
      customers: Array.from(customerMap.values()),
    };
  }

  async getCreditSummary(
    businessId: string,
    filters?: {
      q?: string;
      onlyOverdue?: boolean;
      status?: string;
      sortBy?: 'debt' | 'days' | 'name';
      sortOrder?: 'asc' | 'desc';
      page?: number;
      limit?: number;
    },
  ) {
    await this.ensureCarteraActive(businessId);
    const now = new Date();
    const accounts = await this.prisma.creditAccount.findMany({
      where: {
        businessId,
        status: { notIn: [CreditAccountStatus.PAID, CreditAccountStatus.CANCELLED] },
      },
      include: {
        customer: true,
        sale: { select: { id: true, invoiceNumber: true, total: true, createdAt: true } },
        installments: {
          orderBy: { installmentNumber: 'asc' },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    let totalPortfolio = 0;
    let overduePortfolio = 0;
    let currentPortfolio = 0;
    const customerMap = new Map<string, any>();

    for (const acc of accounts) {
      totalPortfolio += acc.balance;
      const isOverdue = acc.status === CreditAccountStatus.OVERDUE || acc.dueDate < now;
      if (isOverdue) {
        overduePortfolio += acc.balance;
      } else {
        currentPortfolio += acc.balance;
      }

      const formattedInstallments = (acc.installments && acc.installments.length > 0)
        ? acc.installments.map((inst: any) => ({
            ...inst,
            amount: Number(inst.amount),
            paidAmount: Number(inst.paidAmount),
          }))
        : [
            {
              id: `virtual-${acc.id}`,
              creditAccountId: acc.id,
              installmentNumber: 1,
              dueDate: acc.dueDate,
              amount: Number(acc.originalAmount),
              paidAmount: Math.max(0, Math.round((Number(acc.originalAmount) - Number(acc.balance)) * 100) / 100),
              status: acc.status,
              paidAt: acc.status === 'PAID' ? acc.updatedAt : null,
            },
          ];

      if (!customerMap.has(acc.customerId)) {
        customerMap.set(acc.customerId, {
          customer: {
            id: acc.customer.id,
            name: acc.customer.name,
            phone: acc.customer.phone,
            ruc: acc.customer.ruc,
            creditLimit: acc.customer.creditLimit,
          },
          totalDebt: 0,
          overdueDebt: 0,
          currentDebt: 0,
          accountsCount: 0,
          hasOverdue: false,
          daysOverdue: 0,
          accounts: [],
        });
      }

      const custEntry = customerMap.get(acc.customerId);
      custEntry.totalDebt = Math.round((custEntry.totalDebt + acc.balance) * 100) / 100;
      if (isOverdue) {
        custEntry.overdueDebt = Math.round((custEntry.overdueDebt + acc.balance) * 100) / 100;
        custEntry.hasOverdue = true;
        const diffDays = Math.max(
          0,
          Math.floor((now.getTime() - new Date(acc.dueDate).getTime()) / (1000 * 60 * 60 * 24)),
        );
        if (diffDays > custEntry.daysOverdue) {
          custEntry.daysOverdue = diffDays;
        }
      } else {
        custEntry.currentDebt = Math.round((custEntry.currentDebt + acc.balance) * 100) / 100;
      }
      custEntry.accountsCount++;
      custEntry.accounts.push({
        id: acc.id,
        invoiceNumber: acc.sale.invoiceNumber,
        originalAmount: Number(acc.originalAmount),
        balance: Number(acc.balance),
        dueDate: acc.dueDate,
        isOverdue,
        status: acc.status,
        installments: formattedInstallments,
      });
    }

    let customerList = Array.from(customerMap.values());

    // Filtro por búsqueda (nombre, teléfono, RUC)
    if (filters?.q && filters.q.trim()) {
      const qLower = filters.q.toLowerCase().trim();
      customerList = customerList.filter((item) => {
        const nameMatch = item.customer?.name?.toLowerCase().includes(qLower);
        const phoneMatch = item.customer?.phone?.toLowerCase().includes(qLower);
        const rucMatch =
          item.customer?.ruc?.toLowerCase().includes(qLower) ||
          item.customer?.taxId?.toLowerCase().includes(qLower);
        return Boolean(nameMatch || phoneMatch || rucMatch);
      });
    }

    // Filtro por mora / estado
    if (filters?.onlyOverdue || filters?.status === 'OVERDUE') {
      customerList = customerList.filter((item) => item.hasOverdue);
    } else if (filters?.status === 'CURRENT') {
      customerList = customerList.filter((item) => !item.hasOverdue);
    }

    // Ordenamiento
    const sortBy = filters?.sortBy || 'debt';
    const sortAsc = filters?.sortOrder === 'asc';
    customerList.sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'debt') {
        comparison = a.totalDebt - b.totalDebt;
      } else if (sortBy === 'days') {
        comparison = (a.daysOverdue || 0) - (b.daysOverdue || 0);
      } else if (sortBy === 'name') {
        comparison = (a.customer?.name || '').localeCompare(b.customer?.name || '');
      }
      return sortAsc ? comparison : -comparison;
    });

    const totalMatching = customerList.length;

    let paginatedCustomers = customerList;
    let page = filters?.page;
    let limit = filters?.limit;
    let totalPages = 1;

    if (page !== undefined || limit !== undefined) {
      page = Math.max(1, Number(page) || 1);
      limit = Math.min(100, Math.max(1, Number(limit) || 10));
      totalPages = Math.max(1, Math.ceil(totalMatching / limit));
      const skip = (page - 1) * limit;
      paginatedCustomers = customerList.slice(skip, skip + limit);
    }

    return {
      totalPortfolio: Math.round(totalPortfolio * 100) / 100,
      overduePortfolio: Math.round(overduePortfolio * 100) / 100,
      currentPortfolio: Math.round(currentPortfolio * 100) / 100,
      unpaidAccountsCount: accounts.length,
      customersCount: customerMap.size,
      breakdownByCustomer: paginatedCustomers,
      total: totalMatching,
      page: page || 1,
      limit: limit || totalMatching,
      totalPages,
    };
  }

  async getCreditSalesByProduct(businessId: string, from?: string, to?: string) {
    await this.ensureCarteraActive(businessId);
    const dateRange = this.buildDateRange(from, to);
    const where: any = {
      businessId,
      paymentMethod: PosPaymentMethod.CREDITO,
      status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] },
    };
    if (Object.keys(dateRange).length > 0) {
      where.createdAt = dateRange;
    }

    const sales = await this.prisma.sale.findMany({
      where,
      include: {
        items: true,
        customer: { select: { id: true, name: true, phone: true } },
        creditAccount: { select: { id: true, balance: true, status: true, dueDate: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const productMap = new Map<string, { productId: string | null; productName: string; barcode: string | null; quantity: number; revenue: number; salesCount: number }>();
    let totalRevenue = 0;
    let totalQuantity = 0;

    for (const sale of sales) {
      for (const item of sale.items) {
        const netQty = Math.max(0, item.quantity - (item.returnedQty || 0));
        if (netQty <= 0) continue;

        const key = item.productId || item.productName;
        const unitEffective = item.quantity > 0 ? (item.subtotal / item.quantity) : item.unitPrice;
        const itemRevenue = unitEffective * netQty;
        totalRevenue += itemRevenue;
        totalQuantity += netQty;

        if (!productMap.has(key)) {
          productMap.set(key, {
            productId: item.productId,
            productName: item.productName,
            barcode: item.barcode,
            quantity: 0,
            revenue: 0,
            salesCount: 0,
          });
        }

        const prodEntry = productMap.get(key)!;
        prodEntry.quantity = Math.round((prodEntry.quantity + netQty) * 100) / 100;
        prodEntry.revenue = Math.round((prodEntry.revenue + itemRevenue) * 100) / 100;
        prodEntry.salesCount++;
      }
    }

    const sortedProducts = Array.from(productMap.values()).sort((a, b) => b.revenue - a.revenue);

    return {
      from: from || null,
      to: to || null,
      totalSalesCount: sales.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalQuantity: Math.round(totalQuantity * 100) / 100,
      products: sortedProducts,
    };
  }

  async getProfit(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const SOURCES = ['PRODUCT_COST', 'RECIPE', 'PURCHASE', 'LABOR', 'UNKNOWN'] as const;
    const r2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

    const computeProfitMetrics = async (fromDt: Date, toDt: Date) => {
      const rows: any[] = await this.prisma.$queryRaw`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, fromDt, toDt)}
        SELECT
          cost_source AS source,
          COALESCE(SUM(line_revenue), 0)::float AS revenue,
          COALESCE(SUM(unit_cost * net_qty), 0)::float AS cost,
          COUNT(*) FILTER (WHERE NOT is_orphan)::int AS lines,
          COALESCE(SUM(line_revenue) FILTER (WHERE is_orphan), 0)::float AS "orphanRevenue"
        FROM item_sales
        WHERE net_qty > 0
        GROUP BY cost_source;
      `;

      const bySource: Record<string, { revenue: number; cost: number; lines: number }> = {};
      for (const s of SOURCES) bySource[s] = { revenue: 0, cost: 0, lines: 0 };
      let uncategorizedRevenue = 0;
      for (const r of rows) {
        if (!bySource[r.source]) continue;
        bySource[r.source] = { revenue: r2(r.revenue), cost: r2(r.cost), lines: r.lines };
        uncategorizedRevenue += r.orphanRevenue || 0;
      }

      const covered = ['PRODUCT_COST', 'RECIPE', 'PURCHASE', 'LABOR'];
      const totalRevenue = r2(SOURCES.reduce((a, s) => a + bySource[s].revenue, 0));
      const coveredRevenue = r2(covered.reduce((a, s) => a + bySource[s].revenue, 0));
      const uncoveredRevenue = r2(bySource.UNKNOWN.revenue);
      const laborRevenue = bySource.LABOR.revenue;
      const coveragePercent = totalRevenue > 0
        ? Math.round((coveredRevenue / totalRevenue) * 10000) / 100
        : 0;

      let totalCost: number | null = null;
      let estimatedProfit: number | null = null;
      let marginPercent: number | null = null;

      if (coveredRevenue > 0) {
        totalCost = r2(covered.reduce((a, s) => a + bySource[s].cost, 0));
        estimatedProfit = r2(coveredRevenue - totalCost);
        marginPercent = Math.round(((coveredRevenue - totalCost) / coveredRevenue) * 10000) / 100;
      }

      return {
        totalRevenue,
        coveredRevenue,
        uncoveredRevenue,
        laborRevenue,
        coveragePercent,
        totalCost,
        estimatedProfit,
        marginPercent,
        bySource,
        uncategorizedRevenue: r2(uncategorizedRevenue),
      };
    };

    const currentMetrics = await computeProfitMetrics(startDate, endDate);

    const missing: any[] = await this.prisma.$queryRaw`
      WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
      ${this.getProfitItemsSql(businessId, startDate, endDate)}
      SELECT
        product_id AS id,
        product_name AS name,
        SUM(net_qty)::float AS "quantitySold",
        SUM(line_revenue)::float AS "totalSold"
      FROM item_sales
      WHERE cost_source = 'UNKNOWN' AND net_qty > 0 AND NOT is_orphan
      GROUP BY product_id, product_name
      ORDER BY "totalSold" DESC;
    `;


    const prevMetrics = await computeProfitMetrics(range.previous.from, range.previous.to);

    const calcChange = (curr: number | null, prev: number | null): number | null => {
      if (curr === null || prev === null || prev === 0) return null;
      return Math.round(((curr - prev) / Math.abs(prev)) * 10000) / 100;
    };

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      totalRevenue: currentMetrics.totalRevenue,
      coveredRevenue: currentMetrics.coveredRevenue,
      uncoveredRevenue: currentMetrics.uncoveredRevenue,
      coveragePercent: currentMetrics.coveragePercent,
      totalCost: currentMetrics.totalCost,
      estimatedProfit: currentMetrics.estimatedProfit,
      marginPercent: currentMetrics.marginPercent,
      laborRevenue: currentMetrics.laborRevenue,
      bySource: currentMetrics.bySource,
      uncategorizedRevenue: currentMetrics.uncategorizedRevenue,
      missingCostCount: missing.length,
      missingCostProducts: missing.slice(0, 10).map(m => ({
        id: m.id,
        name: m.name,
        quantitySold: Math.round(m.quantitySold * 100) / 100,
        totalSold: Math.round(m.totalSold * 100) / 100,
      })),
      comparison: {
        previousPeriod: { from: range.previous.fromIso, to: range.previous.toIso },
        totalRevenue: {
          current: currentMetrics.totalRevenue,
          previous: prevMetrics.totalRevenue,
          changePercent: calcChange(currentMetrics.totalRevenue, prevMetrics.totalRevenue),
        },
        coveredRevenue: {
          current: currentMetrics.coveredRevenue,
          previous: prevMetrics.coveredRevenue,
          changePercent: calcChange(currentMetrics.coveredRevenue, prevMetrics.coveredRevenue),
        },
        totalCost: {
          current: currentMetrics.totalCost,
          previous: prevMetrics.totalCost,
          changePercent: calcChange(currentMetrics.totalCost, prevMetrics.totalCost),
        },
        estimatedProfit: {
          current: currentMetrics.estimatedProfit,
          previous: prevMetrics.estimatedProfit,
          changePercent: calcChange(currentMetrics.estimatedProfit, prevMetrics.estimatedProfit),
        },
        marginPercent: {
          current: currentMetrics.marginPercent,
          previous: prevMetrics.marginPercent,
          changePercent: currentMetrics.marginPercent !== null && prevMetrics.marginPercent !== null
            ? Math.round((currentMetrics.marginPercent - prevMetrics.marginPercent) * 100) / 100
            : null,
        },
      },
    };
  }

  async getIncomeStatement(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const SOURCES = ['PRODUCT_COST', 'RECIPE', 'PURCHASE', 'LABOR', 'UNKNOWN'] as const;
    const r2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

    const computeSalesAgg = async (fromDt: Date, toDt: Date) => {
      const rows: any[] = await this.prisma.$queryRaw`
        SELECT
          COALESCE(SUM(s.subtotal), 0)::float AS "grossSales",
          COALESCE(SUM(s."discountAmount"), 0)::float AS "discounts",
          COALESCE(SUM(refunds.net_refund), 0)::float AS "returns",
          COALESCE(SUM(GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))), 0)::float AS "netSales",
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
          COALESCE(SUM(GREATEST(0, s."taxAmount" - COALESCE(refunds.tax_refund, 0))), 0)::float AS "taxAmount"
        FROM pos_sales s
        LEFT JOIN (
          SELECT "saleId",
            SUM("refundAmount" - COALESCE("taxRefunded", 0)) AS net_refund,
            SUM(COALESCE("taxRefunded", 0)) AS tax_refund
          FROM pos_sale_returns
          WHERE "businessId" = ${businessId}
          GROUP BY "saleId"
        ) refunds ON refunds."saleId" = s.id
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND (s."createdAt" AT TIME ZONE 'UTC') >= ${fromDt} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${toDt};
      `;
      const row = rows[0] || {};
      const grossSales = r2(row.grossSales || 0);
      const discounts = r2(row.discounts || 0);
      const returns = r2(row.returns || 0);
      const netSales = r2(row.netSales || 0);
      const taxableSales = r2(row.taxableSales || 0);
      const exemptSales = r2(row.exemptSales || 0);
      const taxAmount = r2(row.taxAmount || 0);
      return { grossSales, discounts, returns, netSales, taxableSales, exemptSales, taxAmount };
    };

    const computeProfitMetrics = async (fromDt: Date, toDt: Date) => {
      const rows: any[] = await this.prisma.$queryRaw`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, fromDt, toDt)}
        SELECT
          cost_source AS source,
          COALESCE(SUM(line_revenue), 0)::float AS revenue,
          COALESCE(SUM(unit_cost * net_qty), 0)::float AS cost,
          COUNT(*) FILTER (WHERE NOT is_orphan)::int AS lines,
          COALESCE(SUM(line_revenue) FILTER (WHERE is_orphan), 0)::float AS "orphanRevenue"
        FROM item_sales
        WHERE net_qty > 0
        GROUP BY cost_source;
      `;

      const bySource: Record<string, { revenue: number; cost: number; lines: number }> = {};
      for (const s of SOURCES) bySource[s] = { revenue: 0, cost: 0, lines: 0 };
      for (const r of rows) {
        if (!bySource[r.source]) continue;
        bySource[r.source] = { revenue: r2(r.revenue), cost: r2(r.cost), lines: r.lines };
      }

      const covered = ['PRODUCT_COST', 'RECIPE', 'PURCHASE', 'LABOR'];
      const totalRevenue = r2(SOURCES.reduce((a, s) => a + bySource[s].revenue, 0));
      const coveredRevenue = r2(covered.reduce((a, s) => a + bySource[s].revenue, 0));
      const coveragePercent = totalRevenue > 0
        ? Math.round((coveredRevenue / totalRevenue) * 10000) / 100
        : 100;

      const totalCost = r2(covered.reduce((a, s) => a + bySource[s].cost, 0));
      return {
        totalRevenue,
        coveredRevenue,
        coveragePercent,
        totalCost,
      };
    };

    const computeExpensesAgg = async (fromDt: Date, toDt: Date) => {
      const expenses = await this.prisma.expense.findMany({
        where: {
          businessId,
          isVoided: false,
          expenseDate: {
            gte: fromDt,
            lte: toDt,
          },
        },
        include: {
          category: true,
        },
      });

      const catMap = new Map<string, { categoryId: string; category: string; amount: number }>();
      let total = 0;

      for (const e of expenses) {
        const amt = Number(e.amount);
        total += amt;
        const catId = e.categoryId;
        const catName = e.category?.name || 'Varios';
        const existing = catMap.get(catId);
        if (existing) {
          existing.amount += amt;
        } else {
          catMap.set(catId, { categoryId: catId, category: catName, amount: amt });
        }
      }

      const totalExpenses = r2(total);
      const byCategory = Array.from(catMap.values())
        .map((c) => ({
          categoryId: c.categoryId,
          category: c.category,
          amount: r2(c.amount),
          percent: totalExpenses > 0 ? Math.round((c.amount / totalExpenses) * 10000) / 100 : 0,
        }))
        .sort((a, b) => b.amount - a.amount);

      return {
        total: totalExpenses,
        byCategory,
      };
    };

    const computeInterestIncome = async (fromDt: Date, toDt: Date) => {
      const rows: any[] = await this.prisma.$queryRaw`
        SELECT COALESCE(SUM(cp."interestPortion"), 0)::float AS "interestIncome"
        FROM pos_credit_payments cp
        JOIN pos_credit_accounts ca ON ca.id = cp."creditAccountId"
        WHERE ca."businessId" = ${businessId}
          AND (cp."receivedAt" AT TIME ZONE 'UTC') >= ${fromDt} AND (cp."receivedAt" AT TIME ZONE 'UTC') <= ${toDt};
      `;
      return r2(rows[0]?.interestIncome || 0);
    };

    const [currentSales, currentMetrics, currentExpenses, currentInterestIncome] = await Promise.all([
      computeSalesAgg(startDate, endDate),
      computeProfitMetrics(startDate, endDate),
      computeExpensesAgg(startDate, endDate),
      computeInterestIncome(startDate, endDate),
    ]);

    const missing: any[] = await this.prisma.$queryRaw`
      WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
      ${this.getProfitItemsSql(businessId, startDate, endDate)}
      SELECT
        product_id AS id,
        product_name AS name,
        SUM(net_qty)::float AS "quantitySold",
        SUM(line_revenue)::float AS "totalSold"
      FROM item_sales
      WHERE cost_source = 'UNKNOWN' AND net_qty > 0 AND NOT is_orphan
      GROUP BY product_id, product_name;
    `;

    const costOfGoodsSold = currentMetrics.totalCost;
    const grossProfit = r2(currentSales.netSales - costOfGoodsSold);
    const grossMarginPercent = currentSales.netSales > 0
      ? Math.round((grossProfit / currentSales.netSales) * 10000) / 100
      : 0;

    const operatingProfit = r2(grossProfit - currentExpenses.total);
    const operatingMarginPercent = currentSales.netSales > 0
      ? Math.round((operatingProfit / currentSales.netSales) * 10000) / 100
      : 0;

    const interestIncome = currentInterestIncome;
    const netProfit = r2(operatingProfit + interestIncome);

    // 183d: Ventas con costo cubierto vs ventas sin costo
    const coveredRevenue = missing.length === 0
      ? currentSales.netSales
      : Math.min(currentSales.netSales, Math.max(0, r2(currentMetrics.coveredRevenue)));
    const uncoveredRevenue = Math.max(0, r2(currentSales.netSales - coveredRevenue));

    const coveragePercent = currentSales.netSales > 0
      ? Math.round((coveredRevenue / currentSales.netSales) * 10000) / 100
      : 100;

    const isPartial = coveragePercent < 100 || missing.length > 0;

    const [prevSales, prevMetrics, prevExpenses, prevInterestIncome] = await Promise.all([
      computeSalesAgg(range.previous.from, range.previous.to),
      computeProfitMetrics(range.previous.from, range.previous.to),
      computeExpensesAgg(range.previous.from, range.previous.to),
      computeInterestIncome(range.previous.from, range.previous.to),
    ]);

    const prevGrossProfit = r2(prevSales.netSales - prevMetrics.totalCost);
    const prevOperatingProfit = r2(prevGrossProfit - prevExpenses.total);
    const prevNetProfit = r2(prevOperatingProfit + prevInterestIncome);

    const calcChange = (curr: number, prev: number): number | null => {
      if (prev === 0) return null;
      return Math.round(((curr - prev) / Math.abs(prev)) * 10000) / 100;
    };

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      grossSales: currentSales.grossSales,
      discounts: currentSales.discounts,
      returns: currentSales.returns,
      netSales: currentSales.netSales,
      taxableSales: currentSales.taxableSales,
      exemptSales: currentSales.exemptSales,
      taxAmount: currentSales.taxAmount,
      coveredRevenue,
      uncoveredRevenue,
      costOfGoodsSold,
      grossProfit,
      grossMarginPercent,
      operatingExpenses: currentExpenses,
      operatingProfit,
      operatingMarginPercent,
      interestIncome,
      netProfit,
      isPartial,
      coverage: {
        coveragePercent,
        missingCostCount: missing.length,
      },
      comparison: {
        previousPeriod: { from: range.previous.fromIso, to: range.previous.toIso },
        netSalesChange: calcChange(currentSales.netSales, prevSales.netSales),
        costOfGoodsSoldChange: calcChange(costOfGoodsSold, prevMetrics.totalCost),
        grossProfitChange: calcChange(grossProfit, prevGrossProfit),
        operatingProfitChange: calcChange(operatingProfit, prevOperatingProfit),
        interestIncomeChange: calcChange(interestIncome, prevInterestIncome),
        netProfitChange: calcChange(netProfit, prevNetProfit),
      },
    };
  }

  async getSalesByTime(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const hoursRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        EXTRACT(HOUR FROM (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua')::int AS hour,
        COUNT(s.id)::int AS count,
        COALESCE(SUM(GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))), 0)::float AS revenue
      FROM pos_sales s
      LEFT JOIN (
        SELECT "saleId", SUM("refundAmount" - COALESCE("taxRefunded", 0)) AS net_refund, SUM("refundAmount") AS total_refund
        FROM pos_sale_returns
        WHERE "businessId" = ${businessId}
        GROUP BY "saleId"
      ) refunds ON refunds."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0)
      GROUP BY hour
      ORDER BY hour ASC;
    `;

    const hourMap = new Map<number, { count: number; revenue: number }>();
    for (const r of hoursRaw) {
      hourMap.set(r.hour, { count: r.count, revenue: Math.round(r.revenue * 100) / 100 });
    }

    const byHour: Array<{ hour: number; count: number; revenue: number }> = [];
    let peakHour: { hour: number; count: number; revenue: number } | null = null;
    for (let h = 0; h < 24; h++) {
      const data = hourMap.get(h) || { count: 0, revenue: 0 };
      const item = { hour: h, count: data.count, revenue: data.revenue };
      byHour.push(item);
      if (item.count > 0 && (!peakHour || item.revenue > peakHour.revenue)) {
        peakHour = item;
      }
    }

    const dowRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        EXTRACT(DOW FROM (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua')::int AS dow,
        COUNT(s.id)::int AS count,
        COALESCE(SUM(GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))), 0)::float AS revenue
      FROM pos_sales s
      LEFT JOIN (
        SELECT "saleId", SUM("refundAmount" - COALESCE("taxRefunded", 0)) AS net_refund, SUM("refundAmount") AS total_refund
        FROM pos_sale_returns
        WHERE "businessId" = ${businessId}
        GROUP BY "saleId"
      ) refunds ON refunds."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0)
      GROUP BY dow
      ORDER BY dow ASC;
    `;

    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const dowMap = new Map<number, { count: number; revenue: number }>();
    for (const r of dowRaw) {
      dowMap.set(r.dow, { count: r.count, revenue: Math.round(r.revenue * 100) / 100 });
    }

    const byDayOfWeek: Array<{ dayOfWeek: number; dayName: string; count: number; revenue: number }> = [];
    let peakDay: { dayOfWeek: number; dayName: string; count: number; revenue: number } | null = null;
    for (let d = 0; d < 7; d++) {
      const data = dowMap.get(d) || { count: 0, revenue: 0 };
      const item = { dayOfWeek: d, dayName: dayNames[d], count: data.count, revenue: data.revenue };
      byDayOfWeek.push(item);
      if (item.count > 0 && (!peakDay || item.revenue > peakDay.revenue)) {
        peakDay = item;
      }
    }

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      byHour,
      peakHour,
      byDayOfWeek,
      peakDay,
    };
  }

  async getSalesByCategory(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const rows: any[] = await this.prisma.$queryRaw`
      WITH item_sales AS (
        SELECT
          c.id AS "categoryId",
          c.name AS "categoryName",
          GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0))::float AS quantity,
          (
            ((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))
            * (CASE WHEN s.subtotal > 0 THEN (1 - (s."discountAmount" / s.subtotal)) ELSE 1 END)
          )::float AS revenue
        FROM pos_sale_items i
        JOIN pos_sales s ON s.id = i."saleId"
        LEFT JOIN pos_products p ON p.id = i."productId"
        LEFT JOIN pos_categories c ON c.id = p."categoryId"
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}

        UNION ALL

        SELECT
          NULL AS "categoryId",
          'Sin categoría' AS "categoryName",
          1::float AS quantity,
          GREATEST(0, s.subtotal - s."discountAmount" - COALESCE((
            SELECT SUM("refundAmount" - COALESCE("taxRefunded", 0))
            FROM pos_sale_returns r
            WHERE r."saleId" = s.id
          ), 0))::float AS revenue
        FROM pos_sales s
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
          AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i."saleId" = s.id)
      )
      SELECT
        COALESCE("categoryId", 'uncategorized') AS "categoryId",
        COALESCE("categoryName", 'Sin categoría') AS "categoryName",
        SUM(quantity)::float AS quantity,
        SUM(revenue)::float AS revenue
      FROM item_sales
      WHERE quantity > 0 OR revenue > 0
      GROUP BY "categoryId", "categoryName"
      ORDER BY revenue DESC;
    `;

    const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);

    const categories = rows.map(r => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      quantity: Math.round(r.quantity * 100) / 100,
      revenue: Math.round(r.revenue * 100) / 100,
      percentage: totalRevenue > 0 ? Math.round((r.revenue / totalRevenue) * 10000) / 100 : 0,
    }));

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      categories,
    };
  }

  async getControl(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    // 1. Ventas anuladas
    const voidedSalesAgg: any[] = await this.prisma.$queryRaw`
      SELECT
        COUNT(id)::int AS count,
        COALESCE(SUM(total), 0)::float AS "totalAmount"
      FROM pos_sales
      WHERE "businessId" = ${businessId}
        AND status = 'VOIDED'
        AND (
          (("voidedAt" AT TIME ZONE 'UTC') >= ${startDate} AND ("voidedAt" AT TIME ZONE 'UTC') <= ${endDate})
          OR ("voidedAt" IS NULL AND ("createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND ("createdAt" AT TIME ZONE 'UTC') <= ${endDate})
        );
    `;

    const voidedSalesRecent = await this.prisma.sale.findMany({
      where: {
        businessId,
        status: 'VOIDED',
        OR: [
          { voidedAt: { gte: startDate, lte: endDate } },
          { voidedAt: null, createdAt: { gte: startDate, lte: endDate } },
        ],
      },
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        voidedAt: true,
        createdAt: true,
        voidReason: true,
        voidedById: true,
        voidApprovedById: true,
        cashierId: true,
      },
      orderBy: { voidedAt: 'desc' },
      take: 10,
    });

    // 2. Devoluciones
    const returnsAgg: any[] = await this.prisma.$queryRaw`
      SELECT
        COUNT(id)::int AS count,
        COALESCE(SUM("refundAmount"), 0)::float AS "totalAmount"
      FROM pos_sale_returns
      WHERE "businessId" = ${businessId}
        AND ("createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND ("createdAt" AT TIME ZONE 'UTC') <= ${endDate};
    `;

    const returnsRecent = await this.prisma.saleReturn.findMany({
      where: {
        businessId,
        createdAt: { gte: startDate, lte: endDate },
      },
      select: {
        id: true,
        returnNumber: true,
        refundAmount: true,
        refundMethod: true,
        reason: true,
        createdAt: true,
        createdById: true,
        approvedById: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // 3. Descuentos
    const discountsAgg: any[] = await this.prisma.$queryRaw`
      SELECT
        COUNT(id)::int AS count,
        COALESCE(SUM("discountAmount"), 0)::float AS "totalAmount"
      FROM pos_sales
      WHERE "businessId" = ${businessId}
        AND "discountAmount" > 0
        AND status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND ("createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND ("createdAt" AT TIME ZONE 'UTC') <= ${endDate};
    `;

    const discountsRecent = await this.prisma.sale.findMany({
      where: {
        businessId,
        discountAmount: { gt: 0 },
        status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: {
        id: true,
        invoiceNumber: true,
        subtotal: true,
        discountAmount: true,
        total: true,
        createdAt: true,
        cashierId: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const userIds = new Set<string>();
    for (const v of voidedSalesRecent) {
      if (v.cashierId) userIds.add(v.cashierId);
      if (v.voidedById) userIds.add(v.voidedById);
      if (v.voidApprovedById) userIds.add(v.voidApprovedById);
    }
    for (const r of returnsRecent) {
      if (r.createdById) userIds.add(r.createdById);
      if (r.approvedById) userIds.add(r.approvedById);
    }
    for (const d of discountsRecent) {
      if (d.cashierId) userIds.add(d.cashierId);
    }

    const users = userIds.size > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: Array.from(userIds) } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map(u => [u.id, { id: u.id, name: u.name || u.email }]));

    // 4. Diferencias de caja
    const registersAgg: any[] = await this.prisma.$queryRaw`
      SELECT
        COUNT(id)::int AS count,
        COALESCE(SUM(difference), 0)::float AS "totalDifference",
        COUNT(CASE WHEN difference < 0 THEN 1 END)::int AS "shortageCount",
        COALESCE(SUM(CASE WHEN difference < 0 THEN difference ELSE 0 END), 0)::float AS "shortageTotal",
        COUNT(CASE WHEN difference > 0 THEN 1 END)::int AS "overageCount",
        COALESCE(SUM(CASE WHEN difference > 0 THEN difference ELSE 0 END), 0)::float AS "overageTotal"
      FROM pos_cash_registers
      WHERE "businessId" = ${businessId}
        AND status = 'CLOSED'
        AND ("closedAt" AT TIME ZONE 'UTC') >= ${startDate} AND ("closedAt" AT TIME ZONE 'UTC') <= ${endDate};
    `;

    const registersRecent = await this.prisma.cashRegister.findMany({
      where: {
        businessId,
        status: 'CLOSED',
        closedAt: { gte: startDate, lte: endDate },
      },
      include: {
        cashier: { select: { id: true, name: true, email: true } },
      },
      orderBy: { closedAt: 'desc' },
      take: 10,
    });

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      voidedSales: {
        count: voidedSalesAgg[0]?.count || 0,
        totalAmount: Math.round((voidedSalesAgg[0]?.totalAmount || 0) * 100) / 100,
        recent: voidedSalesRecent.map(v => ({
          id: v.id,
          invoiceNumber: v.invoiceNumber,
          total: v.total,
          createdAt: v.createdAt,
          voidedAt: v.voidedAt || v.createdAt,
          reason: v.voidReason,
          voidReason: v.voidReason,
          selfApproved: v.voidedById != null && v.voidedById === v.voidApprovedById,
          cashier: v.cashierId ? userMap.get(v.cashierId) || null : null,
          voidedBy: v.voidedById ? userMap.get(v.voidedById) || { id: v.voidedById, name: 'Desconocido' } : null,
          approvedBy: v.voidApprovedById ? userMap.get(v.voidApprovedById) || { id: v.voidApprovedById, name: 'Desconocido' } : null,
        })),
      },
      returns: {
        count: returnsAgg[0]?.count || 0,
        totalAmount: Math.round((returnsAgg[0]?.totalAmount || 0) * 100) / 100,
        recent: returnsRecent.map(r => ({
          id: r.id,
          returnNumber: r.returnNumber,
          refundAmount: r.refundAmount,
          refundMethod: r.refundMethod,
          reason: r.reason,
          selfApproved: r.createdById != null && r.createdById === r.approvedById,
          createdAt: r.createdAt,
          createdBy: r.createdById ? userMap.get(r.createdById) || { id: r.createdById, name: 'Desconocido' } : null,
          approvedBy: r.approvedById ? userMap.get(r.approvedById) || { id: r.approvedById, name: 'Desconocido' } : null,
        })),
      },
      discounts: {
        count: discountsAgg[0]?.count || 0,
        totalAmount: Math.round((discountsAgg[0]?.totalAmount || 0) * 100) / 100,
        recent: discountsRecent.map(d => ({
          id: d.id,
          invoiceNumber: d.invoiceNumber,
          subtotal: d.subtotal,
          discountAmount: d.discountAmount,
          total: d.total,
          createdAt: d.createdAt,
          cashier: d.cashierId ? userMap.get(d.cashierId) || { id: d.cashierId, name: 'Desconocido' } : null,
        })),
      },
      cashDiscrepancies: {
        closedRegistersCount: registersAgg[0]?.count || 0,
        totalDifference: Math.round((registersAgg[0]?.totalDifference || 0) * 100) / 100,
        shortageCount: registersAgg[0]?.shortageCount || 0,
        shortageTotal: Math.round((registersAgg[0]?.shortageTotal || 0) * 100) / 100,
        overageCount: registersAgg[0]?.overageCount || 0,
        overageTotal: Math.round((registersAgg[0]?.overageTotal || 0) * 100) / 100,
        recent: registersRecent.map(r => ({
          id: r.id,
          openedAt: r.openedAt,
          closedAt: r.closedAt,
          cashier: { id: r.cashier.id, name: r.cashier.name || r.cashier.email },
          expectedCash: r.expectedCash ? Number(r.expectedCash) : 0,
          closingCash: r.closingCash ? Number(r.closingCash) : 0,
          difference: r.difference ? Number(r.difference) : 0,
          notes: r.notes,
        })),
      },
    };
  }

  async getSalesByCashier(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const rows: any[] = await this.prisma.$queryRaw`
      SELECT
        u.id AS "cashierId",
        COALESCE(u.name, u.email) AS "cashierName",
        COUNT(s.id)::int AS "salesCount",
        COALESCE(SUM(GREATEST(0, s.total - COALESCE(refunds.total_refund, 0))), 0)::float AS "totalSales",
        COALESCE(SUM(GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))), 0)::float AS "netRevenue"
      FROM pos_sales s
      JOIN users u ON u.id = s."cashierId"
      LEFT JOIN (
        SELECT "saleId", SUM("refundAmount" - COALESCE("taxRefunded", 0)) AS net_refund, SUM("refundAmount") AS total_refund
        FROM pos_sale_returns
        WHERE "businessId" = ${businessId}
        GROUP BY "saleId"
      ) refunds ON refunds."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0)
      GROUP BY u.id, u.name, u.email
      ORDER BY "totalSales" DESC;
    `;

    const totalSales = rows.reduce((sum, r) => sum + r.totalSales, 0);

    const cashiers = rows.map(r => ({
      cashierId: r.cashierId,
      cashierName: r.cashierName,
      salesCount: r.salesCount,
      totalSales: Math.round(r.totalSales * 100) / 100,
      netRevenue: Math.round(r.netRevenue * 100) / 100,
      averageTicket: r.salesCount > 0 ? Math.round((r.totalSales / r.salesCount) * 100) / 100 : 0,
      percentage: totalSales > 0 ? Math.round((r.totalSales / totalSales) * 10000) / 100 : 0,
    }));

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      totalSales: Math.round(totalSales * 100) / 100,
      cashiers,
    };
  }

  async getWorkshopReport(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true },
    });

    if (business?.salonProfile !== 'TALLER') {
      return {
        isWorkshop: false,
        period: { from: range.current.fromIso, to: range.current.toIso },
        services: [],
        technicians: [],
        vehiclesAttendedCount: 0,
        vehiclesAttended: [],
      };
    }

    const servicesRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        COALESCE(i."productId", 'unknown') AS "productId",
        i."productName",
        SUM(GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))::float AS quantity,
        SUM((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))::float AS total
      FROM pos_sale_items i
      JOIN pos_sales s ON s.id = i."saleId"
      LEFT JOIN pos_products p ON p.id = i."productId"
      LEFT JOIN pos_categories c ON c.id = p."categoryId"
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        AND s."workshopVehicleId" IS NOT NULL
      GROUP BY i."productId", i."productName"
      HAVING SUM(GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0))) > 0
      ORDER BY total DESC
      LIMIT 10;
    `;

    const techniciansRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        w.id AS "technicianId",
        COALESCE(w.name, 'Sin técnico') AS "technicianName",
        COUNT(o.id)::int AS "ordersCount",
        COALESCE(SUM(s.total), 0)::float AS "totalRevenue"
      FROM pos_table_orders o
      JOIN pos_sales s ON s.id = o."saleId"
      LEFT JOIN pos_waiters w ON w.id = o."assignedWaiterId"
      WHERE o."businessId" = ${businessId}
        AND o.status = 'CLOSED'
        AND o."workshopVehicleId" IS NOT NULL
        AND (COALESCE(o."closedAt", o."createdAt") AT TIME ZONE 'UTC') >= ${startDate}
        AND (COALESCE(o."closedAt", o."createdAt") AT TIME ZONE 'UTC') <= ${endDate}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
      GROUP BY w.id, w.name
      ORDER BY "totalRevenue" DESC;
    `;

    const vehiclesRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        v.id AS "vehicleId",
        v.plate,
        v.description,
        COUNT(o.id)::int AS "ordersCount",
        COALESCE(SUM(s.total), 0)::float AS "totalRevenue"
      FROM pos_table_orders o
      JOIN pos_sales s ON s.id = o."saleId"
      JOIN workshop_vehicles v ON v.id = o."workshopVehicleId"
      WHERE o."businessId" = ${businessId}
        AND o.status = 'CLOSED'
        AND (COALESCE(o."closedAt", o."createdAt") AT TIME ZONE 'UTC') >= ${startDate}
        AND (COALESCE(o."closedAt", o."createdAt") AT TIME ZONE 'UTC') <= ${endDate}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
      GROUP BY v.id, v.plate, v.description
      ORDER BY "totalRevenue" DESC;
    `;

    return {
      isWorkshop: true,
      period: { from: range.current.fromIso, to: range.current.toIso },
      services: servicesRaw.map(s => ({
        productId: s.productId,
        productName: s.productName,
        quantity: Math.round(s.quantity * 100) / 100,
        total: Math.round(s.total * 100) / 100,
      })),
      technicians: techniciansRaw.map(t => ({
        technicianId: t.technicianId,
        technicianName: t.technicianName,
        ordersCount: t.ordersCount,
        totalRevenue: Math.round(t.totalRevenue * 100) / 100,
      })),
      vehiclesAttendedCount: vehiclesRaw.length,
      vehiclesAttended: vehiclesRaw.map(v => ({
        vehicleId: v.vehicleId,
        plate: v.plate,
        description: v.description,
        ordersCount: v.ordersCount,
        totalRevenue: Math.round(v.totalRevenue * 100) / 100,
      })),
    };
  }
}
