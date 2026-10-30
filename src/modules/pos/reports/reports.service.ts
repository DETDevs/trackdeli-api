import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { BusinessProductType, CreditAccountStatus, PosPaymentMethod, Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { BusinessProductsService } from "../../business-products/business-products.service";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import {
  resolveBusinessDateRange,
  buildBusinessDateRange,
  getHourInTimezone,
  DEFAULT_BUSINESS_TIMEZONE,
  getStartOfDayInTimezone,
  getEndOfDayInTimezone,
  formatDateInTimezone,
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
          AND NOT (i."productId" IS NULL AND (LOWER(i."productName") LIKE '%envío%' OR LOWER(i."productName") LIKE '%envio%' OR LOWER(i."productName") LIKE '%domicilio%'))

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

  async getSalesSummary(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
    bankId?: string,
    channel?: string,
  ) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const bankFilterSql = bankId
      ? Prisma.sql`AND s.id IN (SELECT p."saleId" FROM pos_payments p WHERE p."bankId" = ${bankId})`
      : Prisma.empty;

    const channelFilterSql = channel
      ? Prisma.sql`AND s."channel" = ${channel}`
      : Prisma.empty;

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
        AND s.total > COALESCE(refunds.total_refund, 0)
        ${bankFilterSql}
        ${channelFilterSql};
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
        ${bankFilterSql}
        ${channelFilterSql}
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
        ${bankFilterSql}
        ${channelFilterSql}
      GROUP BY TO_CHAR((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua', 'YYYY-MM-DD')
      ORDER BY date ASC;
    `;

    const byBankRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        p.method,
        p."bankId",
        p."bankName",
        COALESCE(SUM(COALESCE(p."amountBase", p.amount)), 0)::float AS revenue
      FROM pos_payments p
      JOIN pos_sales s ON s.id = p."saleId"
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
        ${bankId ? Prisma.sql`AND p."bankId" = ${bankId}` : Prisma.empty}
        ${channelFilterSql}
      GROUP BY p.method, p."bankId", p."bankName";
    `;

    const byPaymentMethod: Record<string, number> = {};
    for (const r of byPaymentMethodRaw) {
      if (r.revenue > 0) {
        byPaymentMethod[r.paymentMethod] = Math.round(r.revenue * 100) / 100;
      }
    }

    const byBank: Record<string, Array<{ bankId: string | null; bankName: string; amount: number }>> = {
      TARJETA: [],
      TRANSFERENCIA: [],
    };
    for (const r of byBankRaw) {
      const m = (r.method || '').toUpperCase();
      const methodKey = m === 'CARD' ? 'TARJETA' : (m === 'TRANSFER' ? 'TRANSFERENCIA' : m);
      if (byBank[methodKey]) {
        byBank[methodKey].push({
          bankId: r.bankId || null,
          bankName: r.bankName || 'Sin banco',
          amount: Math.round(r.revenue * 100) / 100,
        });
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
      byBank,
      byDay,
    };
  }

  async exportSalesSummaryCsv(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
    bankId?: string,
    channel?: string,
  ): Promise<{ filename: string; csvData: string }> {
    const summary = await this.getSalesSummary(businessId, period, from, to, bankId, channel);
    let bankNameFilter = 'Todos';
    if (bankId) {
      const b = await this.prisma.posBank.findFirst({ where: { id: bankId, businessId } });
      if (b) bankNameFilter = b.name;
    }

    const bom = '\uFEFF';
    const sep = ',';
    let csv = bom;

    csv += `REPORTE DE VENTAS Y PAGOS\r\n`;
    csv += `Período${sep}"${summary.period.from}" al "${summary.period.to}"\r\n`;
    csv += `Filtro Banco${sep}"${bankNameFilter}"\r\n`;
    csv += `Filtro Canal${sep}"${channel || 'Todos'}"\r\n`;
    csv += `Generado${sep}"${new Date().toISOString()}"\r\n\r\n`;

    csv += `RESUMEN GENERAL\r\n`;
    csv += `Total Ventas (Cantidad)${sep}${summary.totalSales}\r\n`;
    csv += `Ingresos Netos${sep}${summary.netRevenue.toFixed(2)}\r\n`;
    csv += `Total Comprobantes (con impuestos)${sep}${summary.totalRevenue.toFixed(2)}\r\n`;
    csv += `Ticket Promedio${sep}${summary.averageTicket.toFixed(2)}\r\n\r\n`;

    csv += `DESGLOSE POR MÉTODO DE PAGO\r\n`;
    csv += `Método${sep}Total\r\n`;
    for (const [m, amt] of Object.entries(summary.byPaymentMethod)) {
      csv += `"${m}"${sep}${Number(amt).toFixed(2)}\r\n`;
    }
    csv += `\r\n`;

    csv += `DESGLOSE POR BANCO\r\n`;
    csv += `Método${sep}Banco${sep}Monto\r\n`;
    if (summary.byBank) {
      for (const [method, banks] of Object.entries(summary.byBank)) {
        for (const b of banks as any[]) {
          csv += `"${method}"${sep}"${b.bankName}"${sep}${Number(b.amount).toFixed(2)}\r\n`;
        }
      }
    }
    csv += `\r\n`;

    const fromClean = (summary.period.from || '').split('T')[0];
    const toClean = (summary.period.to || '').split('T')[0];
    const filename = `ventas_pagos_${fromClean}_${toClean}.csv`;

    return { filename, csvData: csv };
  }

  async getTopProducts(businessId: string, period?: string, from?: string, to?: string, limit = 10, channel?: string) {
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

    const channelFilterSql = channel
      ? Prisma.sql`AND s."channel" = ${channel}`
      : Prisma.empty;

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
          AND NOT (i."productId" IS NULL AND (LOWER(i."productName") LIKE '%envío%' OR LOWER(i."productName") LIKE '%envio%' OR LOWER(i."productName") LIKE '%domicilio%'))
          ${channelFilterSql}
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
      const [rows, deliveryRow, pedidosYaSales] = await Promise.all([
        this.prisma.$queryRaw<any[]>`
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
        `,
        this.prisma.$queryRaw<any[]>`
          SELECT
            COALESCE(SUM(
              ((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))
              * (CASE WHEN s.subtotal > 0 THEN (1 - (s."discountAmount" / s.subtotal)) ELSE 1 END)
            ), 0)::float AS delivery_revenue
          FROM pos_sale_items i
          JOIN pos_sales s ON s.id = i."saleId"
          WHERE s."businessId" = ${businessId}
            AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
            AND (s."createdAt" AT TIME ZONE 'UTC') >= ${fromDt} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${toDt}
            AND i."productId" IS NULL
            AND (LOWER(i."productName") LIKE '%envío%' OR LOWER(i."productName") LIKE '%envio%' OR LOWER(i."productName") LIKE '%domicilio%');
        `,
        this.prisma.sale.findMany({
          where: {
            businessId,
            channel: 'PEDIDOSYA',
            status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] },
            createdAt: { gte: fromDt, lte: toDt },
          },
          select: {
            id: true,
            total: true,
            pedidosYaCommissionPct: true,
            pedidosYaTaxPct: true,
            returns: {
              select: {
                refundAmount: true,
              },
            },
          },
        }),
      ]);

      const deliveryRevenue = r2(deliveryRow[0]?.delivery_revenue || 0);

      let pedidosYaCommission = 0;
      let pedidosYaTax = 0;
      for (const s of pedidosYaSales) {
        const refundSum = (s.returns || []).reduce((sum: number, r: any) => sum + Number(r.refundAmount || 0), 0);
        const effectiveTotal = Math.max(0, Number(s.total || 0) - refundSum);
        const commPct = s.pedidosYaCommissionPct != null ? Number(s.pedidosYaCommissionPct) : 27;
        const taxPct = s.pedidosYaTaxPct != null ? Number(s.pedidosYaTaxPct) : 7;
        const effectiveComm = Math.round(effectiveTotal * (commPct / 100) * 100) / 100;
        const effectiveTax = Math.round(effectiveTotal * (taxPct / 100) * 100) / 100;
        pedidosYaCommission += effectiveComm;
        pedidosYaTax += effectiveTax;
      }
      pedidosYaCommission = r2(pedidosYaCommission);
      pedidosYaTax = r2(pedidosYaTax);
      const channelFeesTotal = r2(pedidosYaCommission + pedidosYaTax);
      const channelFees = {
        pedidosYaCommission,
        pedidosYaTax,
        total: channelFeesTotal,
      };

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
        estimatedProfit = r2(coveredRevenue - totalCost - channelFees.total);
        marginPercent = Math.round(((coveredRevenue - totalCost - channelFees.total) / coveredRevenue) * 10000) / 100;
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
        deliveryRevenue,
        channelFees,
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
      deliveryRevenue: currentMetrics.deliveryRevenue,
      channelFees: currentMetrics.channelFees,
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

  async getSalesByTime(businessId: string, period?: string, from?: string, to?: string, channel?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const channelFilterSql = channel
      ? Prisma.sql`AND s."channel" = ${channel}`
      : Prisma.empty;

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
        ${channelFilterSql}
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
        ${channelFilterSql}
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

  async getSalesByCashier(businessId: string, period?: string, from?: string, to?: string, channel?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const channelFilterSql = channel
      ? Prisma.sql`AND s."channel" = ${channel}`
      : Prisma.empty;

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
        ${channelFilterSql}
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

  /**
   * 213a: Reporte por vendedor
   * Métricas: tickets enviados, cobrados, anulados, vencidos, % conversión,
   * monto bruto (solo líneas SELLER), devoluciones descontadas, neto, ticket promedio,
   * unidades y productos más vendidos.
   * Días en hora de Managua.
   */
  async getSalesBySeller(
    businessId: string,
    currentUser: JwtPayload,
    period?: string,
    from?: string,
    to?: string,
    targetSellerId?: string,
    channel?: string,
    topLimit: number = 10,
  ) {
    const { current } = this.resolveDateRange(period, from, to);
    const fromDate = current.from;
    const toDate = current.to;

    // Si el usuario es VENDEDOR, solo ve su propio reporte
    const isVendedor = currentUser.role === UserRole.VENDEDOR;
    const filterSellerId = isVendedor ? currentUser.sub : targetSellerId;

    // Obtener los vendedores del negocio
    const sellersWhere: any = {
      businessId,
      role: UserRole.VENDEDOR,
    };
    if (filterSellerId) {
      sellersWhere.id = filterSellerId;
    }

    const sellers = await this.prisma.user.findMany({
      where: sellersWhere,
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });

    const results = await Promise.all(
      sellers.map(async (seller) => {
        // Tickets del vendedor en el período
        const tickets = await this.prisma.presaleTicket.findMany({
          where: {
            businessId,
            sellerId: seller.id,
            sentAt: { gte: fromDate, lte: toDate },
          },
          select: {
            id: true,
            status: true,
            total: true,
          },
        });

        const ticketsSent = tickets.length;
        const ticketsCharged = tickets.filter((t) => t.status === 'CHARGED').length;
        const ticketsCancelled = tickets.filter((t) => t.status === 'CANCELLED').length;
        const ticketsExpired = tickets.filter((t) => t.status === 'EXPIRED').length;
        const conversionRate =
          ticketsSent > 0 ? Math.round((ticketsCharged / ticketsSent) * 10000) / 100 : 0;

        // Ventas asociadas a este vendedor
        const salesWhere: any = {
          businessId,
          sellerId: seller.id,
          createdAt: { gte: fromDate, lte: toDate },
          status: { not: 'CANCELLED' },
        };
        if (channel) {
          salesWhere.channel = channel;
        }

        const sales = await this.prisma.sale.findMany({
          where: salesWhere,
          select: {
            id: true,
            items: {
              select: {
                productId: true,
                productName: true,
                quantity: true,
                subtotal: true,
                origin: true,
              },
            },
          },
        });

        // Monto bruto: solo líneas SELLER
        let grossSales = 0;
        let unitsSold = 0;
        const productStats = new Map<
          string,
          { productId: string; productName: string; quantity: number; subtotal: number }
        >();

        for (const sale of sales) {
          for (const item of sale.items) {
            if (item.origin === 'SELLER') {
              const sub = Number(item.subtotal);
              const qty = Number(item.quantity);
              grossSales += sub;

              // Excluir línea de envío de topProducts, productsCount y unitsSold
              const isDeliveryItem =
                !item.productId &&
                (item.productName.toLowerCase().includes('envío') ||
                  item.productName.toLowerCase().includes('envio') ||
                  item.productName.toLowerCase().includes('domicilio'));

              if (!isDeliveryItem) {
                unitsSold += qty;

                const key = item.productId || item.productName;
                const existing = productStats.get(key) || {
                  productId: item.productId || '',
                  productName: item.productName,
                  quantity: 0,
                  subtotal: 0,
                };
                existing.quantity += qty;
                existing.subtotal += sub;
                productStats.set(key, existing);
              }
            }
          }
        }

        // Devoluciones descontadas
        const saleIds = sales.map((s) => s.id);
        let returnsAmount = 0;
        if (saleIds.length > 0) {
          const returns = await this.prisma.saleReturn.findMany({
            where: {
              businessId,
              saleId: { in: saleIds },
              createdAt: { gte: fromDate, lte: toDate },
            },
            select: { refundAmount: true },
          });
          returnsAmount = returns.reduce((sum, r) => sum + Number(r.refundAmount || 0), 0);
        }

        const netSales = Math.max(0, Math.round((grossSales - returnsAmount) * 100) / 100);
        const salesCount = sales.length;
        const chargedOrSalesCount = ticketsCharged > 0 ? ticketsCharged : salesCount;
        const averageTicket =
          chargedOrSalesCount > 0 ? Math.round((netSales / chargedOrSalesCount) * 100) / 100 : 0;

        const allProductsSorted = Array.from(productStats.values())
          .sort((a, b) => b.subtotal - a.subtotal)
          .map((p) => ({
            productId: p.productId,
            productName: p.productName,
            units: Math.round(p.quantity * 1000) / 1000,
            revenue: Math.round(p.subtotal * 100) / 100,
          }));

        const productsCount = allProductsSorted.length;
        const topProducts = allProductsSorted.slice(0, topLimit);

        return {
          sellerId: seller.id,
          sellerName: seller.name || seller.email,
          ticketsSent,
          ticketsCharged,
          ticketsCancelled,
          ticketsExpired,
          conversionRate,
          grossSales: Math.round(grossSales * 100) / 100,
          returnsDiscounted: Math.round(returnsAmount * 100) / 100,
          netSales,
          salesCount,
          averageTicket,
          unitsSold: Math.round(unitsSold * 1000) / 1000,
          productsCount,
          topProducts,
          _allProducts: allProductsSorted,
        };
      }),
    );

    return {
      period: {
        from: formatDateInTimezone(fromDate, 'America/Managua'),
        to: formatDateInTimezone(toDate, 'America/Managua'),
      },
      sellers: results.map(({ _allProducts, ...s }) => s),
      _rawResults: results,
    };
  }

  async exportSalesBySellerCsv(
    businessId: string,
    currentUser: JwtPayload,
    period?: string,
    from?: string,
    to?: string,
    targetSellerId?: string,
    channel?: string,
  ): Promise<{ filename: string; csvData: string }> {
    const report: any = await this.getSalesBySeller(
      businessId,
      currentUser,
      period,
      from,
      to,
      targetSellerId,
      channel,
      10000,
    );
    const rawSellers = report._rawResults || report.sellers;

    const bom = '\uFEFF';
    const sep = ',';
    let csv = bom;

    csv += `REPORTE DE VENTAS POR VENDEDOR\r\n`;
    csv += `Período${sep}"${report.period.from}" al "${report.period.to}"\r\n`;
    csv += `Generado${sep}"${new Date().toISOString()}"\r\n\r\n`;

    csv += `RESUMEN POR VENDEDOR\r\n`;
    csv += `Vendedor${sep}Tickets Enviados${sep}Tickets Cobrados${sep}Conversión${sep}Venta Bruta${sep}Devoluciones${sep}Venta Neta${sep}Ticket Promedio${sep}Unidades\r\n`;

    let totalSent = 0;
    let totalCharged = 0;
    let totalGross = 0;
    let totalReturns = 0;
    let totalNet = 0;
    let totalUnits = 0;

    for (const s of rawSellers) {
      totalSent += s.ticketsSent || 0;
      totalCharged += s.ticketsCharged || 0;
      totalGross += s.grossSales || 0;
      totalReturns += s.returnsDiscounted || 0;
      totalNet += s.netSales || 0;
      totalUnits += s.unitsSold || 0;

      csv += `"${s.sellerName}"${sep}${s.ticketsSent}${sep}${s.ticketsCharged}${sep}${s.conversionRate.toFixed(2)}%${sep}${s.grossSales.toFixed(2)}${sep}${s.returnsDiscounted.toFixed(2)}${sep}${s.netSales.toFixed(2)}${sep}${s.averageTicket.toFixed(2)}${sep}${s.unitsSold.toFixed(2)}\r\n`;
    }

    const totalAvgTicket = totalCharged > 0 ? (totalNet / totalCharged) : 0;
    const totalConversion = totalSent > 0 ? ((totalCharged / totalSent) * 100) : 0;
    csv += `TOTALES${sep}${totalSent}${sep}${totalCharged}${sep}${totalConversion.toFixed(2)}%${sep}${totalGross.toFixed(2)}${sep}${totalReturns.toFixed(2)}${sep}${totalNet.toFixed(2)}${sep}${totalAvgTicket.toFixed(2)}${sep}${totalUnits.toFixed(2)}\r\n\r\n`;

    csv += `PRODUCTOS VENDIDOS POR VENDEDOR\r\n`;
    csv += `Vendedor${sep}Producto${sep}Unidades${sep}Venta\r\n`;
    for (const s of rawSellers) {
      const prods = s._allProducts || s.topProducts || [];
      for (const p of prods) {
        csv += `"${s.sellerName}"${sep}"${p.productName}"${sep}${p.units.toFixed(2)}${sep}${p.revenue.toFixed(2)}\r\n`;
      }
    }
    csv += `\r\n`;

    const fromClean = (report.period.from || '').split('T')[0];
    const toClean = (report.period.to || '').split('T')[0];
    const filename = `ventas_por_vendedor_${fromClean}_${toClean}.csv`;

    return { filename, csvData: csv };
  }

  // ═══════════════════════════════════════════════
  // REPORTES DE CANALES DE VENTA (221a)
  // ═══════════════════════════════════════════════

  /**
   * GET /pos/reports/sales-by-channel
   * Resumen y desglose por canal (MOSTRADOR, DOMICILIO, PEDIDOSYA)
   */
  async getSalesByChannelReport(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
  ) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const channelsRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        COALESCE(s."channel", 'MOSTRADOR') AS channel,
        COUNT(s.id)::int AS count,
        COALESCE(SUM(s.total), 0)::float AS gross,
        COALESCE(SUM(s."taxAmount"), 0)::float AS tax,
        COALESCE(SUM(s.subtotal - s."discountAmount"), 0)::float AS net,
        COALESCE(SUM(items_sum.qty), 0)::float AS units
      FROM pos_sales s
      LEFT JOIN (
        SELECT "saleId", SUM(quantity)::float AS qty
        FROM pos_sale_items
        GROUP BY "saleId"
      ) items_sum ON items_sum."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
      GROUP BY COALESCE(s."channel", 'MOSTRADOR')
    `;

    const totalGrossAll = channelsRaw.reduce((sum, r) => sum + Number(r.gross || 0), 0);

    const validChannels = ['MOSTRADOR', 'DOMICILIO', 'PEDIDOSYA'];
    const summary = validChannels.map((ch) => {
      const found = channelsRaw.find((r) => r.channel === ch) || {
        count: 0,
        gross: 0,
        tax: 0,
        net: 0,
        units: 0,
      };
      const count = Number(found.count || 0);
      const gross = Math.round(Number(found.gross || 0) * 100) / 100;
      const tax = Math.round(Number(found.tax || 0) * 100) / 100;
      const net = Math.round(Number(found.net || 0) * 100) / 100;
      const units = Math.round(Number(found.units || 0) * 1000) / 1000;
      const avgTicket = count > 0 ? Math.round((gross / count) * 100) / 100 : 0;
      const pctOfTotal = totalGrossAll > 0 ? Math.round((gross / totalGrossAll) * 10000) / 100 : 0;

      return {
        channel: ch,
        count,
        gross,
        tax,
        net,
        units,
        avgTicket,
        pctOfTotal,
      };
    });

    const byDayRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        TO_CHAR((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua', 'YYYY-MM-DD') AS date,
        COALESCE(s."channel", 'MOSTRADOR') AS channel,
        COUNT(s.id)::int AS count,
        COALESCE(SUM(s.total), 0)::float AS gross
      FROM pos_sales s
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
      GROUP BY TO_CHAR((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua', 'YYYY-MM-DD'), COALESCE(s."channel", 'MOSTRADOR')
      ORDER BY date ASC, channel ASC;
    `;

    const byHourRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        EXTRACT(HOUR FROM (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua')::int AS hour,
        COALESCE(s."channel", 'MOSTRADOR') AS channel,
        COUNT(s.id)::int AS count,
        COALESCE(SUM(s.total), 0)::float AS gross
      FROM pos_sales s
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND (s."createdAt" AT TIME ZONE 'UTC') >= ${startDate} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${endDate}
      GROUP BY hour, COALESCE(s."channel", 'MOSTRADOR')
      ORDER BY hour ASC, channel ASC;
    `;

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      totalGross: Math.round(totalGrossAll * 100) / 100,
      summary,
      byDay: byDayRaw.map((r) => ({
        date: r.date,
        channel: r.channel,
        count: r.count,
        gross: Math.round(r.gross * 100) / 100,
      })),
      byHour: byHourRaw.map((r) => ({
        hour: r.hour,
        channel: r.channel,
        count: r.count,
        gross: Math.round(r.gross * 100) / 100,
      })),
    };
  }

  async exportSalesByChannelCsv(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
  ): Promise<{ filename: string; csvData: string }> {
    const report = await this.getSalesByChannelReport(businessId, period, from, to);
    const bom = '\uFEFF';
    const sep = ',';
    let csv = bom;

    csv += `REPORTE DE VENTAS POR CANAL\r\n`;
    csv += `Período${sep}"${report.period.from}" al "${report.period.to}"\r\n`;
    csv += `Generado${sep}"${new Date().toISOString()}"\r\n\r\n`;

    csv += `RESUMEN POR CANAL\r\n`;
    csv += `Canal${sep}Ventas (Cant)${sep}Bruto${sep}Impuesto${sep}Neto${sep}Unidades${sep}Ticket Promedio${sep}% del Total\r\n`;
    for (const s of report.summary) {
      csv += `"${s.channel}"${sep}${s.count}${sep}${s.gross.toFixed(2)}${sep}${s.tax.toFixed(2)}${sep}${s.net.toFixed(2)}${sep}${s.units.toFixed(2)}${sep}${s.avgTicket.toFixed(2)}${sep}${s.pctOfTotal.toFixed(2)}%\r\n`;
    }
    csv += `\r\n`;

    csv += `VENTAS POR DÍA Y CANAL\r\n`;
    csv += `Fecha${sep}Canal${sep}Ventas (Cant)${sep}Monto Bruto\r\n`;
    for (const d of report.byDay) {
      csv += `"${d.date}"${sep}"${d.channel}"${sep}${d.count}${sep}${d.gross.toFixed(2)}\r\n`;
    }
    csv += `\r\n`;

    const fromClean = (report.period.from || '').split('T')[0];
    const toClean = (report.period.to || '').split('T')[0];
    const filename = `ventas_por_canal_${fromClean}_${toClean}.csv`;

    return { filename, csvData: csv };
  }

  /**
   * GET /pos/reports/domicilio
   * Pedidos a domicilio, tarifas cobradas y desglose por repartidor y dirección
   */
  async getDomicilioReport(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
    driverId?: string,
  ) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const driverFilter = driverId ? { deliveryDriverId: driverId } : {};

    const sales = await this.prisma.sale.findMany({
      where: {
        businessId,
        channel: 'DOMICILIO',
        status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] },
        createdAt: { gte: startDate, lte: endDate },
        ...driverFilter,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        invoiceNumber: true,
        createdAt: true,
        occurredAt: true,
        customerName: true,
        deliveryAddress: true,
        deliveryPhone: true,
        deliveryReference: true,
        deliveryDriverId: true,
        deliveryDriverName: true,
        deliveryFee: true,
        total: true,
        status: true,
      },
    });

    const totalOrders = sales.length;
    const totalSales = sales.reduce((sum, s) => sum + Number(s.total || 0), 0);
    const totalDeliveryFees = sales.reduce((sum, s) => sum + Number(s.deliveryFee || 0), 0);

    const driverStatsMap = new Map<string, { driverId: string | null; driverName: string; ordersCount: number; totalFees: number; totalSales: number }>();
    const addressStatsMap = new Map<string, { address: string; ordersCount: number }>();

    for (const s of sales) {
      const dKey = s.deliveryDriverId || s.deliveryDriverName || 'SIN_ASIGNAR';
      const dName = s.deliveryDriverName || (s.deliveryDriverId ? 'Repartidor' : 'Sin asignar');
      const dEntry = driverStatsMap.get(dKey) || {
        driverId: s.deliveryDriverId || null,
        driverName: dName,
        ordersCount: 0,
        totalFees: 0,
        totalSales: 0,
      };
      dEntry.ordersCount++;
      dEntry.totalFees += Number(s.deliveryFee || 0);
      dEntry.totalSales += Number(s.total || 0);
      driverStatsMap.set(dKey, dEntry);

      if (s.deliveryAddress) {
        const addrKey = s.deliveryAddress.trim().toLowerCase();
        const aEntry = addressStatsMap.get(addrKey) || { address: s.deliveryAddress.trim(), ordersCount: 0 };
        aEntry.ordersCount++;
        addressStatsMap.set(addrKey, aEntry);
      }
    }

    const byDriver = Array.from(driverStatsMap.values()).map((d) => ({
      ...d,
      totalFees: Math.round(d.totalFees * 100) / 100,
      totalSales: Math.round(d.totalSales * 100) / 100,
    })).sort((a, b) => b.ordersCount - a.ordersCount);

    const byAddress = Array.from(addressStatsMap.values())
      .sort((a, b) => b.ordersCount - a.ordersCount)
      .slice(0, 15);

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      totalOrders,
      totalSales: Math.round(totalSales * 100) / 100,
      totalDeliveryFees: Math.round(totalDeliveryFees * 100) / 100,
      byDriver,
      byAddress,
      orders: sales.map((s) => ({
        id: s.id,
        invoiceNumber: s.invoiceNumber,
        date: s.occurredAt || s.createdAt,
        customerName: s.customerName,
        deliveryAddress: s.deliveryAddress,
        deliveryPhone: s.deliveryPhone,
        deliveryReference: s.deliveryReference,
        deliveryDriverName: s.deliveryDriverName,
        deliveryFee: s.deliveryFee != null ? Number(s.deliveryFee) : 0,
        total: Number(s.total),
        status: s.status,
      })),
    };
  }

  async exportDomicilioReportCsv(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
    driverId?: string,
  ): Promise<{ filename: string; csvData: string }> {
    const report = await this.getDomicilioReport(businessId, period, from, to, driverId);
    const bom = '\uFEFF';
    const sep = ',';
    let csv = bom;

    csv += `REPORTE DE VENTAS A DOMICILIO\r\n`;
    csv += `Período${sep}"${report.period.from}" al "${report.period.to}"\r\n`;
    csv += `Generado${sep}"${new Date().toISOString()}"\r\n\r\n`;

    csv += `RESUMEN\r\n`;
    csv += `Total Pedidos${sep}${report.totalOrders}\r\n`;
    csv += `Total Ventas${sep}${report.totalSales.toFixed(2)}\r\n`;
    csv += `Total Envíos Cobrados${sep}${report.totalDeliveryFees.toFixed(2)}\r\n\r\n`;

    csv += `POR REPARTIDOR\r\n`;
    csv += `Repartidor${sep}Pedidos${sep}Total Envíos${sep}Total Ventas\r\n`;
    for (const d of report.byDriver) {
      csv += `"${d.driverName}"${sep}${d.ordersCount}${sep}${d.totalFees.toFixed(2)}${sep}${d.totalSales.toFixed(2)}\r\n`;
    }
    csv += `\r\n`;

    csv += `DETALLE DE PEDIDOS\r\n`;
    csv += `Comprobante${sep}Fecha${sep}Cliente${sep}Dirección${sep}Teléfono${sep}Repartidor${sep}Envío${sep}Total\r\n`;
    for (const o of report.orders) {
      const dateStr = o.date ? new Date(o.date).toISOString().split('T')[0] : '';
      csv += `"${o.invoiceNumber}"${sep}"${dateStr}"${sep}"${o.customerName || ''}"${sep}"${o.deliveryAddress || ''}"${sep}"${o.deliveryPhone || ''}"${sep}"${o.deliveryDriverName || ''}"${sep}${o.deliveryFee.toFixed(2)}${sep}${o.total.toFixed(2)}\r\n`;
    }
    csv += `\r\n`;

    const fromClean = (report.period.from || '').split('T')[0];
    const toClean = (report.period.to || '').split('T')[0];
    const filename = `ventas_domicilio_${fromClean}_${toClean}.csv`;

    return { filename, csvData: csv };
  }

  /**
   * GET /pos/reports/pedidosya
   * Reporte financiero de PedidosYa (comisiones, impuestos, net payout, estatus de liquidación)
   */
  async getPedidosYaReport(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
    status?: string,
    paymentMode?: string,
  ) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const extraWhere: any = {};
    if (status) {
      extraWhere.pedidosYaSettlementStatus = status;
    }
    if (paymentMode) {
      extraWhere.pedidosYaPaymentMode = paymentMode;
    }

    const sales = await this.prisma.sale.findMany({
      where: {
        businessId,
        channel: 'PEDIDOSYA',
        status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] },
        createdAt: { gte: startDate, lte: endDate },
        ...extraWhere,
      },
      include: {
        items: true,
        returns: {
          select: {
            refundAmount: true,
          },
        },
        pedidosYaSettlement: {
          select: {
            depositDate: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalOrders = sales.length;
    let grossTotal = 0;
    let totalCommission = 0;
    let totalTax = 0;
    let totalAppGross = 0;

    const byPaymentMode = {
      APP: { count: 0, total: 0, commission: 0, tax: 0, netPayout: 0 },
      EFECTIVO: { count: 0, total: 0, commission: 0, tax: 0, netPayout: 0 },
    };

    const bySettlementStatus = {
      PENDIENTE: { count: 0, total: 0, netPayout: 0 },
      LIQUIDADO: { count: 0, total: 0, netPayout: 0 },
    };

    const productMap = new Map<string, { productId: string | null; productName: string; quantity: number; gross: number }>();

    for (const s of sales) {
      const refundSum = (s.returns || []).reduce((sum: number, r: any) => sum + Number(r.refundAmount || 0), 0);
      const tot = Math.max(0, Number(s.total || 0) - refundSum);
      const commPct = s.pedidosYaCommissionPct != null ? Number(s.pedidosYaCommissionPct) : 27;
      const taxPct = s.pedidosYaTaxPct != null ? Number(s.pedidosYaTaxPct) : 7;
      const comm = Math.round(tot * (commPct / 100) * 100) / 100;
      const tx = Math.round(tot * (taxPct / 100) * 100) / 100;
      const pMode = s.pedidosYaPaymentMode === 'EFECTIVO' ? 'EFECTIVO' : 'APP';
      const sStatus = s.pedidosYaSettlementStatus === 'LIQUIDADO' ? 'LIQUIDADO' : 'PENDIENTE';

      grossTotal += tot;
      totalCommission += comm;
      totalTax += tx;

      if (pMode === 'APP') {
        totalAppGross += tot;
        byPaymentMode.APP.count++;
        byPaymentMode.APP.total += tot;
        byPaymentMode.APP.commission += comm;
        byPaymentMode.APP.tax += tx;
      } else {
        byPaymentMode.EFECTIVO.count++;
        byPaymentMode.EFECTIVO.total += tot;
        byPaymentMode.EFECTIVO.commission += comm;
        byPaymentMode.EFECTIVO.tax += tx;
      }

      const orderNet = pMode === 'APP' ? (tot - comm - tx) : (-comm - tx);

      if (sStatus === 'LIQUIDADO') {
        bySettlementStatus.LIQUIDADO.count++;
        bySettlementStatus.LIQUIDADO.total += tot;
        bySettlementStatus.LIQUIDADO.netPayout += orderNet;
      } else {
        bySettlementStatus.PENDIENTE.count++;
        bySettlementStatus.PENDIENTE.total += tot;
        bySettlementStatus.PENDIENTE.netPayout += orderNet;
      }

      for (const item of s.items) {
        const pKey = item.productId || item.productName;
        const pEntry = productMap.get(pKey) || {
          productId: item.productId || null,
          productName: item.productName,
          quantity: 0,
          gross: 0,
        };
        pEntry.quantity += Number(item.quantity || 0);
        pEntry.gross += Number(item.subtotal || 0);
        productMap.set(pKey, pEntry);
      }
    }

    // netPayout = ventas APP - comisiones e impuestos de TODOS los pedidos
    const netPayout = totalAppGross - totalCommission - totalTax;

    byPaymentMode.APP.netPayout = Math.round((byPaymentMode.APP.total - byPaymentMode.APP.commission - byPaymentMode.APP.tax) * 100) / 100;
    byPaymentMode.APP.total = Math.round(byPaymentMode.APP.total * 100) / 100;
    byPaymentMode.APP.commission = Math.round(byPaymentMode.APP.commission * 100) / 100;
    byPaymentMode.APP.tax = Math.round(byPaymentMode.APP.tax * 100) / 100;

    byPaymentMode.EFECTIVO.total = Math.round(byPaymentMode.EFECTIVO.total * 100) / 100;
    byPaymentMode.EFECTIVO.commission = Math.round(byPaymentMode.EFECTIVO.commission * 100) / 100;
    byPaymentMode.EFECTIVO.tax = Math.round(byPaymentMode.EFECTIVO.tax * 100) / 100;
    byPaymentMode.EFECTIVO.netPayout = Math.round((-byPaymentMode.EFECTIVO.commission - byPaymentMode.EFECTIVO.tax) * 100) / 100;

    bySettlementStatus.PENDIENTE.total = Math.round(bySettlementStatus.PENDIENTE.total * 100) / 100;
    bySettlementStatus.PENDIENTE.netPayout = Math.round(bySettlementStatus.PENDIENTE.netPayout * 100) / 100;
    bySettlementStatus.LIQUIDADO.total = Math.round(bySettlementStatus.LIQUIDADO.total * 100) / 100;
    bySettlementStatus.LIQUIDADO.netPayout = Math.round(bySettlementStatus.LIQUIDADO.netPayout * 100) / 100;

    const topProducts = Array.from(productMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10)
      .map((p) => ({
        ...p,
        quantity: Math.round(p.quantity * 1000) / 1000,
        gross: Math.round(p.gross * 100) / 100,
      }));

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      summary: {
        totalOrders,
        grossTotal: Math.round(grossTotal * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        totalTax: Math.round(totalTax * 100) / 100,
        netPayout: Math.round(netPayout * 100) / 100,
      },
      byPaymentMode,
      bySettlementStatus,
      topProducts,
      orders: sales.map((s) => {
        const refundSum = (s.returns || []).reduce((sum: number, r: any) => sum + Number(r.refundAmount || 0), 0);
        const tot = Math.max(0, Number(s.total || 0) - refundSum);
        const commPct = s.pedidosYaCommissionPct != null ? Number(s.pedidosYaCommissionPct) : 27;
        const taxPct = s.pedidosYaTaxPct != null ? Number(s.pedidosYaTaxPct) : 7;
        const comm = Math.round(tot * (commPct / 100) * 100) / 100;
        const tx = Math.round(tot * (taxPct / 100) * 100) / 100;
        const pMode = s.pedidosYaPaymentMode === 'EFECTIVO' ? 'EFECTIVO' : 'APP';
        const orderNet = pMode === 'APP' ? Math.round((tot - comm - tx) * 100) / 100 : Math.round((-comm - tx) * 100) / 100;

        return {
          id: s.id,
          invoiceNumber: s.invoiceNumber,
          pedidosYaOrderNumber: s.pedidosYaOrderNumber,
          date: s.occurredAt || s.createdAt,
          total: tot,
          originalTotal: Number(s.total || 0),
          refundedAmount: refundSum,
          commissionPct: commPct,
          taxPct,
          commissionAmount: comm,
          taxAmount: tx,
          netPayout: orderNet,
          paymentMode: pMode,
          settlementStatus: s.pedidosYaSettlementStatus || 'PENDIENTE',
          settlementDate: s.pedidosYaSettlement?.depositDate || null,
        };
      }),
    };
  }

  async exportPedidosYaReportCsv(
    businessId: string,
    period?: string,
    from?: string,
    to?: string,
    status?: string,
    paymentMode?: string,
  ): Promise<{ filename: string; csvData: string }> {
    const report = await this.getPedidosYaReport(businessId, period, from, to, status, paymentMode);
    const bom = '\uFEFF';
    const sep = ',';
    let csv = bom;

    csv += `REPORTE DE PEDIDOSYA\r\n`;
    csv += `Período${sep}"${report.period.from}" al "${report.period.to}"\r\n`;
    csv += `Generado${sep}"${new Date().toISOString()}"\r\n\r\n`;

    csv += `RESUMEN GENERAL\r\n`;
    csv += `Total Pedidos${sep}${report.summary.totalOrders}\r\n`;
    csv += `Venta Bruta Total${sep}${report.summary.grossTotal.toFixed(2)}\r\n`;
    csv += `Comisión Total${sep}${report.summary.totalCommission.toFixed(2)}\r\n`;
    csv += `Impuesto s/Comisión${sep}${report.summary.totalTax.toFixed(2)}\r\n`;
    csv += `Neto a Cobrar / Pagar${sep}${report.summary.netPayout.toFixed(2)}\r\n\r\n`;

    csv += `DETALLE DE PEDIDOS\r\n`;
    csv += `Comprobante${sep}Nº PedidosYa${sep}Fecha${sep}Modo Pago${sep}Total${sep}Comisión${sep}Impuesto${sep}Neto${sep}Estado Liquidación\r\n`;
    for (const o of report.orders) {
      const dateStr = o.date ? new Date(o.date).toISOString().split('T')[0] : '';
      csv += `"${o.invoiceNumber}"${sep}"${o.pedidosYaOrderNumber || ''}"${sep}"${dateStr}"${sep}"${o.paymentMode || ''}"${sep}${o.total.toFixed(2)}${sep}${o.commissionAmount.toFixed(2)}${sep}${o.taxAmount.toFixed(2)}${sep}${o.netPayout.toFixed(2)}${sep}"${o.settlementStatus}"\r\n`;
    }
    csv += `\r\n`;

    const fromClean = (report.period.from || '').split('T')[0];
    const toClean = (report.period.to || '').split('T')[0];
    const filename = `pedidosya_${fromClean}_${toClean}.csv`;

    return { filename, csvData: csv };
  }
}
