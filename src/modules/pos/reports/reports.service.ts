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
          (
            ((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))
            * (CASE WHEN s.subtotal > 0 THEN (s."discountAmount" / s.subtotal) ELSE 0 END)
          )::float AS line_discount,
          COALESCE(i."unit_cost", pc.unit_cost)::float AS unit_cost,
          CASE
            WHEN i."cost_source" IS NOT NULL THEN
              CASE WHEN i."cost_source" = 'NONE' THEN 'UNKNOWN' ELSE i."cost_source" END
            ELSE COALESCE(pc.cost_source, 'UNKNOWN')
          END AS cost_source,
          (i."cost_source" IS NOT NULL) AS is_historical,
          false AS is_orphan,
          s.id AS sale_id,
          s."customerId" AS customer_id,
          COALESCE(cust.name, s."customerName", 'Cliente Mostrador') AS customer_name,
          COALESCE(s."channel", 'MOSTRADOR') AS channel,
          ((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua') AS created_at_local,
          TO_CHAR((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua', 'YYYY-MM-DD') AS sale_date_local,
          EXTRACT(HOUR FROM (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua')::int AS sale_hour_local,
          p."categoryId" AS category_id,
          cat.name AS category_name,
          COALESCE(p.unit, 'UND') AS unit,
          s."createdAt" AS sale_created_at
        FROM pos_sale_items i
        JOIN pos_sales s ON s.id = i."saleId"
        LEFT JOIN product_costs pc ON pc.product_id = i."productId"
        LEFT JOIN pos_products p ON p.id = i."productId"
        LEFT JOIN pos_categories cat ON cat.id = p."categoryId"
        LEFT JOIN customers cust ON cust.id = s."customerId"
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
          s."discountAmount"::float AS line_discount,
          NULL::float AS unit_cost,
          'UNKNOWN' AS cost_source,
          false AS is_historical,
          true AS is_orphan,
          s.id AS sale_id,
          s."customerId" AS customer_id,
          COALESCE(cust.name, s."customerName", 'Cliente Mostrador') AS customer_name,
          COALESCE(s."channel", 'MOSTRADOR') AS channel,
          ((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua') AS created_at_local,
          TO_CHAR((s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua', 'YYYY-MM-DD') AS sale_date_local,
          EXTRACT(HOUR FROM (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Managua')::int AS sale_hour_local,
          NULL AS category_id,
          'Sin categoría' AS category_name,
          'UND' AS unit,
          s."createdAt" AS sale_created_at
        FROM pos_sales s
        LEFT JOIN customers cust ON cust.id = s."customerId"
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND (s."createdAt" AT TIME ZONE 'UTC') >= ${fromDt} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${toDt}
          AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i."saleId" = s.id)
      )
    `;
  }

  private calculatePedidosYaOrderFees(sale: {
    status?: string | null;
    total?: any;
    pedidosYaCommissionPct?: any;
    pedidosYaTaxPct?: any;
    returns?: Array<{ refundAmount?: any }> | null;
  }): {
    effectiveTotal: number;
    refundSum: number;
    commPct: number;
    taxPct: number;
    commission: number;
    tax: number;
    total: number;
  } {
    const commPct =
      sale.pedidosYaCommissionPct != null ? Number(sale.pedidosYaCommissionPct) : 27;
    const taxPct = sale.pedidosYaTaxPct != null ? Number(sale.pedidosYaTaxPct) : 7;
    const refundSum = (sale.returns || []).reduce(
      (sum, r) => sum + Number(r.refundAmount || 0),
      0,
    );
    if (sale.status === 'RETURNED') {
      return { effectiveTotal: 0, refundSum, commPct, taxPct, commission: 0, tax: 0, total: 0 };
    }
    const effectiveTotal = Math.max(0, Number(sale.total || 0) - refundSum);
    const commission = Math.round(effectiveTotal * (commPct / 100) * 100) / 100;
    const tax = Math.round(effectiveTotal * (taxPct / 100) * 100) / 100;
    return {
      effectiveTotal,
      refundSum,
      commPct,
      taxPct,
      commission,
      tax,
      total: Math.round((commission + tax) * 100) / 100,
    };
  }

  private async aggregatePedidosYaFees(businessId: string, fromDt: Date, toDt: Date) {
    const sales = await this.prisma.sale.findMany({
      where: {
        businessId,
        channel: 'PEDIDOSYA',
        status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] },
        createdAt: { gte: fromDt, lte: toDt },
      },
      select: {
        createdAt: true,
        status: true,
        total: true,
        pedidosYaCommissionPct: true,
        pedidosYaTaxPct: true,
        returns: { select: { refundAmount: true } },
      },
    });

    let commission = new Prisma.Decimal(0);
    let tax = new Prisma.Decimal(0);
    const byDay = new Map<string, Prisma.Decimal>();
    const byHour = new Map<number, Prisma.Decimal>();

    for (const s of sales) {
      const fees = this.calculatePedidosYaOrderFees(s);
      const c = new Prisma.Decimal(fees.commission);
      const t = new Prisma.Decimal(fees.tax);
      const tot = c.plus(t);
      commission = commission.plus(c);
      tax = tax.plus(t);

      const dayKey = formatDateInTimezone(s.createdAt, 'America/Managua');
      byDay.set(dayKey, (byDay.get(dayKey) || new Prisma.Decimal(0)).plus(tot));
      const hourKey = getHourInTimezone(s.createdAt, 'America/Managua');
      byHour.set(hourKey, (byHour.get(hourKey) || new Prisma.Decimal(0)).plus(tot));
    }

    return {
      hasOrders: sales.length > 0,
      commission,
      tax,
      total: commission.plus(tax),
      byDay,
      byHour,
    };
  }

  private async computeDeliveryRevenueDetails(
    businessId: string,
    fromDt: Date,
    toDt: Date,
    isDeliveryTaxable: boolean,
  ) {
    const sales = await this.prisma.sale.findMany({
      where: {
        businessId,
        channel: 'DOMICILIO',
        status: { in: ['COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED'] },
        createdAt: { gte: fromDt, lte: toDt },
        deliveryFee: { gt: 0 },
      },
      select: {
        id: true,
        status: true,
        deliveryFee: true,
        subtotal: true,
        discountAmount: true,
        total: true,
        taxModel: true,
        taxIncluded: true,
        taxRate: true,
        createdAt: true,
        returns: { select: { refundAmount: true } },
        items: {
          where: {
            productId: null,
            OR: [
              { productName: { contains: 'envío', mode: 'insensitive' } },
              { productName: { contains: 'envio', mode: 'insensitive' } },
              { productName: { contains: 'domicilio', mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        },
      },
    });

    let total = new Prisma.Decimal(0);
    let offlineTotal = new Prisma.Decimal(0);
    const byDay = new Map<string, Prisma.Decimal>();
    const byHour = new Map<number, Prisma.Decimal>();

    for (const s of sales) {
      if (s.status === 'RETURNED') continue;
      let baseFee = new Prisma.Decimal(s.deliveryFee || 0);
      if (baseFee.lte(0)) continue;

      const hasDeliveryItem = (s.items || []).length > 0;
      if (
        hasDeliveryItem &&
        s.taxModel === 'LEGACY' &&
        s.taxIncluded &&
        Number(s.taxRate) > 0 &&
        isDeliveryTaxable
      ) {
        const rateDiv = new Prisma.Decimal(1).plus(new Prisma.Decimal(s.taxRate).div(100));
        baseFee = baseFee.div(rateDiv);
      }

      if (hasDeliveryItem && Number(s.subtotal || 0) > 0 && Number(s.discountAmount || 0) > 0) {
        const sub = new Prisma.Decimal(s.subtotal);
        const disc = new Prisma.Decimal(s.discountAmount);
        const factor = Prisma.Decimal.max(0, new Prisma.Decimal(1).minus(disc.div(sub)));
        baseFee = baseFee.mul(factor);
      }

      if (s.status === 'PARTIALLY_RETURNED' && Number(s.total || 0) > 0) {
        const refundSum = (s.returns || []).reduce(
          (acc, r) => acc.plus(new Prisma.Decimal(r.refundAmount || 0)),
          new Prisma.Decimal(0),
        );
        const tot = new Prisma.Decimal(s.total);
        const factor = Prisma.Decimal.min(
          1,
          Prisma.Decimal.max(0, tot.minus(refundSum).div(tot)),
        );
        baseFee = baseFee.mul(factor);
      }

      const saleDeliv = baseFee.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      total = total.plus(saleDeliv);
      if (!hasDeliveryItem) {
        offlineTotal = offlineTotal.plus(saleDeliv);
      }

      const dayKey = formatDateInTimezone(s.createdAt, 'America/Managua');
      byDay.set(dayKey, (byDay.get(dayKey) || new Prisma.Decimal(0)).plus(saleDeliv));
      const hourKey = getHourInTimezone(s.createdAt, 'America/Managua');
      byHour.set(hourKey, (byHour.get(hourKey) || new Prisma.Decimal(0)).plus(saleDeliv));
    }

    return {
      total: total.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      offlineTotal: offlineTotal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      byDay,
      byHour,
    };
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

    const SOURCES = ['PRODUCT', 'PRODUCT_COST', 'RECIPE', 'PURCHASE', 'LABOR', 'BATCH', 'UNKNOWN'] as const;
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
        const fees = this.calculatePedidosYaOrderFees(s);
        pedidosYaCommission += fees.commission;
        pedidosYaTax += fees.tax;
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

      const covered = ['PRODUCT', 'PRODUCT_COST', 'RECIPE', 'PURCHASE', 'LABOR', 'BATCH'];
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

  private async computeExpensesAgg(businessId: string, fromDt: Date, toDt: Date) {
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

    const r2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
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
  }

  async getProfitSummary(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;
    const r2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
    const d = (n: any) => new Prisma.Decimal(n || 0);
    const d2 = (x: Prisma.Decimal) =>
      x.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();

    const bizConfig = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { pedidosYaChannelEnabled: true, deliveryTaxable: true, taxEnabled: true },
    });
    const pedidosYaEnabled = Boolean(bizConfig?.pedidosYaChannelEnabled);
    const isDeliveryTaxable = bizConfig?.deliveryTaxable ?? Boolean(bizConfig?.taxEnabled);

    const computePeriod = async (fromDt: Date, toDt: Date) => {
      const [channelRows, pyFees, deliv] = await Promise.all([
        this.prisma.$queryRaw<any[]>`
          WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
          ${this.getProfitItemsSql(businessId, fromDt, toDt)}
          SELECT
            (channel = 'PEDIDOSYA') AS is_pedidosya,
            COUNT(DISTINCT sale_id)::int AS receipts,
            COALESCE(SUM(line_revenue), 0)::float AS sales,
            COALESCE(SUM(line_discount), 0)::float AS discounts,
            COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN line_revenue ELSE 0 END), 0)::float AS covered_sales,
            COALESCE(SUM(CASE WHEN cost_source = 'UNKNOWN' THEN line_revenue ELSE 0 END), 0)::float AS uncovered_sales,
            COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN unit_cost * net_qty ELSE 0 END), 0)::float AS cost,
            COUNT(*)::int AS total_lines,
            COALESCE(SUM(CASE WHEN is_historical THEN 1 ELSE 0 END), 0)::int AS historical_lines,
            COALESCE(SUM(CASE WHEN is_historical THEN line_revenue ELSE 0 END), 0)::float AS historical_sales
          FROM item_sales
          WHERE net_qty > 0
          GROUP BY (channel = 'PEDIDOSYA');
        `,
        this.aggregatePedidosYaFees(businessId, fromDt, toDt),
        this.computeDeliveryRevenueDetails(businessId, fromDt, toDt, isDeliveryTaxable),
      ]);

      const ownRaw = channelRows.find((row) => !row.is_pedidosya);
      const pyRaw = channelRows.find((row) => Boolean(row.is_pedidosya));

      let receipts = 0;
      let totalLines = 0;
      let historicalLines = 0;
      let discounts = new Prisma.Decimal(0);
      let uncoveredSum = new Prisma.Decimal(0);
      let historicalSalesSum = new Prisma.Decimal(0);
      for (const row of channelRows) {
        receipts += Number(row.receipts || 0);
        totalLines += Number(row.total_lines || 0);
        historicalLines += Number(row.historical_lines || 0);
        discounts = discounts.plus(d(row.discounts));
        uncoveredSum = uncoveredSum.plus(d(row.uncovered_sales));
        historicalSalesSum = historicalSalesSum.plus(d(row.historical_sales));
      }

      const ownSalesDec = d(ownRaw?.sales);
      const ownCoveredDec = d(ownRaw?.covered_sales);
      const ownCostDec = d(ownRaw?.cost);
      const ownSalesNum = d2(ownSalesDec);
      const ownCoveredNum = d2(ownCoveredDec);
      const ownCostNum = d2(ownCostDec);
      const ownUncoveredNum = Math.max(0, r2(ownSalesNum - ownCoveredNum));
      const ownZeroCoverage = ownSalesNum > 0 && ownCoveredNum === 0;
      const ownProductProfit = ownZeroCoverage
        ? null
        : ownSalesNum === 0 && ownCoveredNum === 0
          ? 0
          : d2(ownCoveredDec.minus(ownCostDec));
      const ownMarginPercent =
        ownProductProfit !== null && ownCoveredDec.gt(0)
          ? d2(d(ownProductProfit).div(ownCoveredDec).mul(100))
          : null;

      const ownCol = {
        sales: ownSalesNum,
        coveredSales: ownCoveredNum,
        uncoveredSales: ownUncoveredNum,
        cost: ownCostNum,
        channelFees: null as null | { commission: number; tax: number; total: number },
        netSales: ownSalesNum,
        productProfit: ownProductProfit,
        marginPercent: ownMarginPercent,
      };

      const pySalesDec = d(pyRaw?.sales);
      const pyCoveredDec = d(pyRaw?.covered_sales);
      const pyCostDec = d(pyRaw?.cost);
      const pySalesNum = d2(pySalesDec);
      const pyCoveredNum = d2(pyCoveredDec);
      const pyCostNum = d2(pyCostDec);
      const pyCommNum = d2(pyFees.commission);
      const pyTaxNum = d2(pyFees.tax);
      const pyFeesTotalDec = d(pyCommNum).plus(d(pyTaxNum));
      const pyFeesTotalNum = d2(pyFeesTotalDec);

      const includePedidosYa =
        pedidosYaEnabled || pySalesNum > 0 || pyFees.hasOrders || pyFeesTotalNum > 0;

      let pyCol: typeof ownCol | null = null;
      let pyCoveredNetDec = new Prisma.Decimal(0);

      if (includePedidosYa) {
        const pyUncoveredNum = Math.max(0, r2(pySalesNum - pyCoveredNum));
        const pyNetSalesNum = d2(pySalesDec.minus(pyFeesTotalDec));
        const pyFeesCoveredDec = pySalesDec.gt(0)
          ? pyFeesTotalDec.mul(pyCoveredDec).div(pySalesDec)
          : new Prisma.Decimal(0);
        pyCoveredNetDec = pyCoveredDec.minus(pyFeesCoveredDec);
        const pyZeroCoverage = pySalesNum > 0 && pyCoveredNum === 0;
        const pyProductProfit = pyZeroCoverage
          ? null
          : pySalesNum === 0 && pyCoveredNum === 0
            ? 0
            : d2(pyCoveredNetDec.minus(pyCostDec));
        const pyMarginPercent =
          pyProductProfit !== null && pyCoveredNetDec.gt(0)
            ? d2(d(pyProductProfit).div(pyCoveredNetDec).mul(100))
            : null;

        pyCol = {
          sales: pySalesNum,
          coveredSales: pyCoveredNum,
          uncoveredSales: pyUncoveredNum,
          cost: pyCostNum,
          channelFees: {
            commission: pyCommNum,
            tax: pyTaxNum,
            total: pyFeesTotalNum,
          },
          netSales: pyNetSalesNum,
          productProfit: pyProductProfit,
          marginPercent: pyMarginPercent,
        };
      }

      const totalSalesNum = pyCol ? r2(ownCol.sales + pyCol.sales) : ownCol.sales;
      const totalCoveredNum = pyCol
        ? r2(ownCol.coveredSales + pyCol.coveredSales)
        : ownCol.coveredSales;
      const totalUncoveredNum = pyCol
        ? r2(ownCol.uncoveredSales + pyCol.uncoveredSales)
        : ownCol.uncoveredSales;
      const totalCostNum = pyCol ? r2(ownCol.cost + pyCol.cost) : ownCol.cost;
      const totalNetSalesNum = pyCol ? r2(ownCol.netSales + pyCol.netSales) : ownCol.netSales;
      const totalZeroCoverage = totalSalesNum > 0 && totalCoveredNum === 0;
      const totalProductProfit = totalZeroCoverage
        ? null
        : pyCol
          ? r2((ownCol.productProfit ?? 0) + (pyCol.productProfit ?? 0))
          : ownCol.productProfit;
      const totalCoveredNetDec = pyCol
        ? (ownCol.productProfit !== null ? ownCoveredDec : new Prisma.Decimal(0)).plus(
            pyCol.productProfit !== null ? pyCoveredNetDec : new Prisma.Decimal(0),
          )
        : ownCoveredDec;
      const totalMarginPercent =
        totalProductProfit !== null && totalCoveredNetDec.gt(0)
          ? d2(d(totalProductProfit).div(totalCoveredNetDec).mul(100))
          : null;

      const totalCol = {
        sales: totalSalesNum,
        coveredSales: totalCoveredNum,
        uncoveredSales: totalUncoveredNum,
        cost: totalCostNum,
        channelFees: pyCol ? pyCol.channelFees : null,
        netSales: totalNetSalesNum,
        productProfit: totalProductProfit,
        marginPercent: totalMarginPercent,
      };

      const deliveryRevenue = d2(deliv.total);
      const totalProfit =
        totalCol.productProfit === null ? null : r2(totalCol.productProfit + deliveryRevenue);

      const sales = totalCol.sales;
      const historicalSales = d2(historicalSalesSum);

      let costBasis: 'HISTORICAL' | 'CURRENT' | 'MIXED' = 'HISTORICAL';
      let historicalSharePercent = 100;
      let costBasisNote = 'Se calcula con el costo que tenía cada producto al venderse.';

      if (totalLines === 0 || historicalLines === totalLines) {
        costBasis = 'HISTORICAL';
        historicalSharePercent = 100;
        costBasisNote = 'Se calcula con el costo que tenía cada producto al venderse.';
      } else if (historicalLines === 0) {
        costBasis = 'CURRENT';
        historicalSharePercent = 0;
        costBasisNote = 'Se calcula con el costo actual de cada producto.';
      } else {
        costBasis = 'MIXED';
        historicalSharePercent =
          sales > 0 ? Math.round((historicalSales / sales) * 10000) / 100 : 0;
        costBasisNote =
          'Parte de las ventas de este período es anterior al registro del costo y se calcula con el costo actual.';
      }

      return {
        totals: {
          sales: totalCol.sales,
          coveredSales: totalCol.coveredSales,
          cost: totalCol.cost,
          grossProfit: totalCol.productProfit,
          marginPercent: totalCol.marginPercent,
          discounts: d2(discounts),
          receipts,
          uncoveredRevenue: d2(uncoveredSum),
          deliveryRevenue,
          totalProfit,
        },
        channelSummary: {
          own: ownCol,
          pedidosYa: pyCol,
          total: totalCol,
          deliveryRevenue,
          totalProfit,
        },
        pyFees,
        deliv,
        costBasis,
        historicalSharePercent,
        costBasisNote,
      };
    };

    const [
      currentPeriod,
      prevPeriod,
      daysRaw,
      hoursRaw,
      categoriesRaw,
      customersRaw,
      productsRaw,
      hasCartera,
    ] = await Promise.all([
      computePeriod(startDate, endDate),
      computePeriod(range.previous.from, range.previous.to),
      // byDay (split OWN vs PEDIDOSYA)
      this.prisma.$queryRaw<any[]>`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, startDate, endDate)}
        SELECT
          sale_date_local::text AS date,
          (channel = 'PEDIDOSYA') AS is_pedidosya,
          COALESCE(SUM(line_revenue), 0)::float AS sales,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN unit_cost * net_qty ELSE 0 END), 0)::float AS cost,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN line_revenue ELSE 0 END), 0)::float AS covered_sales
        FROM item_sales
        WHERE net_qty > 0
        GROUP BY sale_date_local, (channel = 'PEDIDOSYA')
        ORDER BY sale_date_local ASC;
      `,
      // byHour (split OWN vs PEDIDOSYA)
      this.prisma.$queryRaw<any[]>`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, startDate, endDate)}
        SELECT
          sale_hour_local AS hour,
          (channel = 'PEDIDOSYA') AS is_pedidosya,
          COALESCE(SUM(line_revenue), 0)::float AS sales,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN unit_cost * net_qty ELSE 0 END), 0)::float AS cost,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN line_revenue ELSE 0 END), 0)::float AS covered_sales
        FROM item_sales
        WHERE net_qty > 0
        GROUP BY sale_hour_local, (channel = 'PEDIDOSYA')
        ORDER BY sale_hour_local ASC;
      `,
      // byCategory
      this.prisma.$queryRaw<any[]>`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, startDate, endDate)}
        SELECT
          category_id AS "categoryId",
          COALESCE(category_name, 'Sin categoría') AS name,
          COALESCE(SUM(line_revenue), 0)::float AS sales,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN unit_cost * net_qty ELSE 0 END), 0)::float AS cost,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN line_revenue - (unit_cost * net_qty) ELSE 0 END), 0)::float AS profit,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN line_revenue ELSE 0 END), 0)::float AS covered_sales
        FROM item_sales
        WHERE net_qty > 0
        GROUP BY category_id, COALESCE(category_name, 'Sin categoría')
        ORDER BY profit DESC, sales DESC;
      `,
      // byCustomer
      this.prisma.$queryRaw<any[]>`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, startDate, endDate)}
        SELECT
          customer_id AS "customerId",
          customer_name AS name,
          COUNT(DISTINCT sale_id)::int AS receipts,
          COALESCE(SUM(line_revenue), 0)::float AS sales,
          COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN line_revenue - (unit_cost * net_qty) ELSE 0 END), 0)::float AS profit
        FROM item_sales
        WHERE net_qty > 0
        GROUP BY customer_id, customer_name;
      `,
      // products for alerts
      this.prisma.$queryRaw<any[]>`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, startDate, endDate)}
        SELECT
          product_id AS "productId",
          (ARRAY_AGG(product_name ORDER BY sale_created_at DESC))[1] AS name,
          cost_source,
          COALESCE(SUM(line_revenue), 0)::float AS sales,
          COALESCE(SUM(unit_cost * net_qty), 0)::float AS cost,
          COALESCE(SUM(line_revenue - (unit_cost * net_qty)), 0)::float AS profit
        FROM item_sales
        WHERE net_qty > 0 AND NOT is_orphan
        GROUP BY product_id, cost_source;
      `,
      this.businessProductsService.isActive(businessId, BusinessProductType.CARTERA_COBRO),
    ]);

    const currentTotals = currentPeriod.totals;
    const prevTotals = prevPeriod.totals;

    const previous =
      prevTotals.receipts === 0 && prevTotals.sales === 0 && prevTotals.deliveryRevenue === 0
        ? null
        : prevTotals;

    let expenses: any = null;
    let netProfit: number | null = null;
    if (hasCartera) {
      const expData = await this.computeExpensesAgg(businessId, startDate, endDate);
      expenses = expData;
      netProfit =
        currentTotals.totalProfit !== null
          ? r2(currentTotals.totalProfit - expData.total)
          : null;
    }

    const netProfitNote =
      currentTotals.uncoveredRevenue > 0
        ? 'La utilidad neta no incluye la ganancia de las ventas sin costo registrado.'
        : null;

    const fromDay = formatDateInTimezone(startDate, 'America/Managua');
    const toDay = formatDateInTimezone(endDate, 'America/Managua');
    const isSingleDay = fromDay === toDay;

    const computeBucketMetrics = (
      ownRow: any,
      pyRow: any,
      pyFeesBucket: Prisma.Decimal,
      delivBucket: Prisma.Decimal,
    ) => {
      const ownS = d(ownRow?.sales);
      const ownCov = d(ownRow?.covered_sales);
      const ownC = d(ownRow?.cost);
      const pyS = d(pyRow?.sales);
      const pyCov = d(pyRow?.covered_sales);
      const pyC = d(pyRow?.cost);

      const s = d2(ownS.plus(pyS));
      const cov = d2(ownCov.plus(pyCov));
      const c = d2(ownC.plus(pyC));

      const pyFeesCovered = pyS.gt(0)
        ? pyFeesBucket.mul(pyCov).div(pyS)
        : new Prisma.Decimal(0);
      const prodProfitDec = ownCov.minus(ownC).plus(pyCov.minus(pyC).minus(pyFeesCovered));
      const p = d2(prodProfitDec.plus(delivBucket));
      const covNet = ownCov.plus(pyCov).minus(pyFeesCovered);
      const m =
        cov > 0 && covNet.gt(0)
          ? d2(d(d2(prodProfitDec)).div(covNet).mul(100))
          : null;

      return { sales: s, coveredSales: cov, cost: c, profit: p, marginPercent: m };
    };

    const reconcileBucketProfits = <T extends { sales: number; coveredSales: number; profit: number }>(
      buckets: T[],
    ) => {
      if (currentTotals.totalProfit === null || buckets.length === 0) return;
      const sumBuckets = buckets.reduce((acc, b) => acc.plus(b.profit), new Prisma.Decimal(0));
      const diff = d(currentTotals.totalProfit)
        .minus(sumBuckets)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      if (diff.isZero()) return;
      let targetIdx = 0;
      for (let i = 1; i < buckets.length; i++) {
        if (
          buckets[i].coveredSales > buckets[targetIdx].coveredSales ||
          (buckets[i].coveredSales === buckets[targetIdx].coveredSales &&
            buckets[i].sales > buckets[targetIdx].sales)
        ) {
          targetIdx = i;
        }
      }
      buckets[targetIdx].profit = d2(d(buckets[targetIdx].profit).plus(diff));
    };

    // Build byDay
    const dayOwnMap = new Map<string, any>();
    const dayPyMap = new Map<string, any>();
    for (const r of daysRaw) {
      if (r.is_pedidosya) dayPyMap.set(r.date, r);
      else dayOwnMap.set(r.date, r);
    }
    const byDay: Array<{
      date: string;
      sales: number;
      coveredSales: number;
      cost: number;
      profit: number;
      marginPercent: number | null;
    }> = [];
    let curDay = fromDay;
    while (curDay <= toDay) {
      const m = computeBucketMetrics(
        dayOwnMap.get(curDay),
        dayPyMap.get(curDay),
        currentPeriod.pyFees.byDay.get(curDay) || new Prisma.Decimal(0),
        currentPeriod.deliv.byDay.get(curDay) || new Prisma.Decimal(0),
      );
      byDay.push({ date: curDay, ...m });
      const [y, mth, dayNum] = curDay.split('-').map(Number);
      const nextDt = new Date(Date.UTC(y, mth - 1, dayNum + 1));
      curDay = nextDt.toISOString().slice(0, 10);
    }
    reconcileBucketProfits(byDay);

    // Build byHour (if single day)
    let byHour: Array<{
      hour: number;
      date: string;
      sales: number;
      coveredSales: number;
      cost: number;
      profit: number;
      marginPercent: number | null;
    }> | undefined;
    if (isSingleDay) {
      const hourOwnMap = new Map<number, any>();
      const hourPyMap = new Map<number, any>();
      for (const r of hoursRaw) {
        const h = Number(r.hour);
        if (r.is_pedidosya) hourPyMap.set(h, r);
        else hourOwnMap.set(h, r);
      }
      byHour = [];
      for (let h = 0; h < 24; h++) {
        const m = computeBucketMetrics(
          hourOwnMap.get(h),
          hourPyMap.get(h),
          currentPeriod.pyFees.byHour.get(h) || new Prisma.Decimal(0),
          currentPeriod.deliv.byHour.get(h) || new Prisma.Decimal(0),
        );
        byHour.push({
          hour: h,
          date: `${String(h).padStart(2, '0')}:00`,
          ...m,
        });
      }
      reconcileBucketProfits(byHour);
    }

    // bestDay
    let bestDay: { date: string; profit: number } | null = null;
    for (const d of byDay) {
      if (!bestDay || d.profit > bestDay.profit) {
        bestDay = { date: d.date, profit: d.profit };
      }
    }
    if (bestDay && byDay.every((d) => d.sales === 0)) {
      bestDay = null;
    }

    // byCategory
    const sumPositiveCategoryProfits = categoriesRaw
      .map((r) => r2(r.profit))
      .filter((p) => p > 0)
      .reduce((sum, p) => sum + p, 0);

    const byCategory = categoriesRaw.map((r) => {
      const s = r2(r.sales);
      const cov = r2(r.covered_sales);
      const c = r2(r.cost);
      const p = r2(r.profit);
      const m = cov > 0 ? Math.round((p / cov) * 10000) / 100 : null;

      const salesSharePercent = currentTotals.sales > 0
        ? Math.round((s / currentTotals.sales) * 10000) / 100
        : 0;

      let sharePercent: number | null = null;
      if (currentTotals.grossProfit > 0 && p > 0 && sumPositiveCategoryProfits > 0) {
        sharePercent = Math.round((p / sumPositiveCategoryProfits) * 10000) / 100;
      }

      return {
        categoryId: r.categoryId || null,
        name: r.name,
        sales: s,
        coveredSales: cov,
        cost: c,
        profit: p,
        marginPercent: m,
        salesSharePercent,
        sharePercent,
      };
    });

    // byCustomer & counterSales
    const customersWithId = customersRaw.filter((r) => r.customerId !== null);
    const counterRaw = customersRaw.filter((r) => r.customerId === null);
    customersWithId.sort((a, b) => b.profit - a.profit);
    const byCustomer = customersWithId.slice(0, 10).map((c) => ({
      customerId: c.customerId,
      name: c.name,
      receipts: c.receipts,
      sales: r2(c.sales),
      profit: r2(c.profit),
    }));

    const counterSales = {
      receipts: counterRaw.reduce((sum, c) => sum + c.receipts, 0),
      sales: r2(counterRaw.reduce((sum, c) => sum + c.sales, 0)),
      profit: r2(counterRaw.reduce((sum, c) => sum + c.profit, 0)),
    };

    // alerts
    const lossItems = productsRaw.filter((p) => p.cost_source !== 'UNKNOWN' && p.profit < -0.001);
    const lowMarginItems = productsRaw.filter(
      (p) =>
        p.cost_source !== 'UNKNOWN' &&
        p.profit >= -0.001 &&
        p.sales > 0 &&
        p.profit / p.sales < 0.10,
    );
    const missingCostItems = productsRaw.filter((p) => p.cost_source === 'UNKNOWN');
    missingCostItems.sort((a, b) => b.sales - a.sales);

    const alerts = {
      lossProducts: {
        count: lossItems.length,
        lossAmount: r2(Math.abs(lossItems.reduce((sum, i) => sum + i.profit, 0))),
      },
      lowMarginProducts: {
        count: lowMarginItems.length,
      },
      missingCost: {
        count: missingCostItems.length,
        revenue: r2(missingCostItems.reduce((sum, i) => sum + i.sales, 0)),
        products: missingCostItems.slice(0, 10).map((p) => ({
          productId: p.productId,
          name: p.name,
        })),
      },
    };

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      previousPeriod: { from: range.previous.fromIso, to: range.previous.toIso },
      totals: currentTotals,
      channelSummary: currentPeriod.channelSummary,
      previous,
      costBasis: currentPeriod.costBasis,
      historicalSharePercent: currentPeriod.historicalSharePercent,
      costBasisNote: currentPeriod.costBasisNote,
      expenses,
      netProfit,
      netProfitNote,
      byDay,
      ...(isSingleDay && byHour ? { byHour } : {}),
      byCategory,
      byCustomer,
      counterSales,
      alerts,
      bestDay,
    };
  }

  async getProfitProducts(
    businessId: string,
    dto: {
      period?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
      sort?: string;
      dir?: string;
      search?: string;
      categoryId?: string;
      filter?: string;
    },
  ) {
    const range = this.resolveDateRange(dto.period, dto.from, dto.to);
    const startDate = range.current.from;
    const endDate = range.current.to;
    const r2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

    const rawProducts: any[] = await this.prisma.$queryRaw`
      WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
      ${this.getProfitItemsSql(businessId, startDate, endDate)}
      SELECT
        product_id AS "productId",
        (ARRAY_AGG(product_name ORDER BY sale_created_at DESC))[1] AS name,
        (ARRAY_AGG(category_id ORDER BY sale_created_at DESC))[1] AS "categoryId",
        (ARRAY_AGG(COALESCE(category_name, 'Sin categoría') ORDER BY sale_created_at DESC))[1] AS category,
        (ARRAY_AGG(unit ORDER BY sale_created_at DESC))[1] AS unit,
        (ARRAY_AGG(cost_source ORDER BY sale_created_at DESC))[1] AS cost_source,
        SUM(net_qty)::float AS "unitsSold",
        COALESCE(SUM(line_revenue), 0)::float AS sales,
        COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN unit_cost * net_qty ELSE NULL END), 0)::float AS cost,
        COALESCE(SUM(CASE WHEN cost_source != 'UNKNOWN' THEN line_revenue - (unit_cost * net_qty) ELSE NULL END), 0)::float AS profit
      FROM item_sales
      WHERE net_qty > 0
      GROUP BY product_id;
    `;

    let items = rawProducts.map((p) => {
      const hasCost = p.cost_source !== 'UNKNOWN' && p.cost !== null;
      const unitsSold = r2(p.unitsSold);
      const sales = r2(p.sales);
      let cost: number | null = null;
      let profit: number | null = null;
      let marginPercent: number | null = null;

      if (hasCost) {
        cost = r2(p.cost);
        profit = r2(p.profit);
        marginPercent = sales > 0 ? Math.round((profit / sales) * 10000) / 100 : 0;
      }

      return {
        productId: p.productId || null,
        name: p.name || 'Sin nombre',
        category: p.category || 'Sin categoría',
        categoryId: p.categoryId || null,
        unit: p.unit || 'UND',
        unitsSold,
        sales,
        cost,
        profit,
        marginPercent,
        hasCost,
      };
    });

    // 1. Search filter
    if (dto.search && dto.search.trim()) {
      const normalize = (s: string) =>
        (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const term = normalize(dto.search);
      items = items.filter((i) => normalize(i.name).includes(term));
    }

    // 2. Category filter
    if (dto.categoryId && dto.categoryId.trim()) {
      items = items.filter((i) => i.categoryId === dto.categoryId.trim());
    }

    // 3. Condition filter
    const filter = (dto.filter || 'all').toLowerCase().trim();
    if (filter === 'loss') {
      items = items.filter((i) => i.hasCost && i.profit !== null && i.profit < -0.001);
    } else if (filter === 'lowmargin') {
      items = items.filter(
        (i) =>
          i.hasCost &&
          i.profit !== null &&
          i.profit >= -0.001 &&
          i.marginPercent !== null &&
          i.marginPercent >= 0 &&
          i.marginPercent < 10,
      );
    } else if (filter === 'nocost') {
      items = items.filter((i) => !i.hasCost);
    }

    // Totals of all filtered items
    const totalSales = r2(items.reduce((sum, i) => sum + i.sales, 0));
    const totalUnits = r2(items.reduce((sum, i) => sum + i.unitsSold, 0));
    const itemsWithCost = items.filter((i) => i.hasCost && i.cost !== null && i.profit !== null);
    const totalCost = itemsWithCost.length > 0 ? r2(itemsWithCost.reduce((sum, i) => sum + (i.cost || 0), 0)) : null;
    const totalProfit = itemsWithCost.length > 0 ? r2(itemsWithCost.reduce((sum, i) => sum + (i.profit || 0), 0)) : null;
    const coveredSales = itemsWithCost.reduce((sum, i) => sum + i.sales, 0);
    const totalCoveredSales = r2(coveredSales);
    const totalMarginPercent = totalCoveredSales > 0 && totalProfit !== null
      ? Math.round((totalProfit / totalCoveredSales) * 10000) / 100
      : null;

    const totals = {
      sales: totalSales,
      coveredSales: totalCoveredSales,
      cost: totalCost,
      profit: totalProfit,
      marginPercent: totalMarginPercent,
      unitsSold: totalUnits,
    };

    // Calculate salesSharePercent and sharePercent for each item
    const sumPositiveProfits = items
      .filter((i) => i.hasCost && i.profit !== null && i.profit > 0)
      .reduce((sum, i) => sum + (i.profit || 0), 0);

    const itemsWithShares = items.map((i) => {
      const salesSharePercent = totalSales > 0
        ? Math.round((i.sales / totalSales) * 10000) / 100
        : 0;

      let sharePercent: number | null = null;
      if (totalProfit !== null && totalProfit > 0 && i.hasCost && i.profit !== null && i.profit > 0 && sumPositiveProfits > 0) {
        sharePercent = Math.round((i.profit / sumPositiveProfits) * 10000) / 100;
      }

      return {
        ...i,
        salesSharePercent,
        sharePercent,
      };
    });

    // Sort items
    const sortCol = (dto.sort || 'profit').toLowerCase().trim();
    const isNameSort = sortCol === 'name';
    const defaultDir = isNameSort ? 'asc' : 'desc';
    const dir = (dto.dir || defaultDir).toLowerCase().trim();
    const mult = dir === 'asc' ? 1 : -1;

    itemsWithShares.sort((a, b) => {
      let valA: any;
      let valB: any;
      switch (sortCol) {
        case 'name':
          return mult * a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
        case 'sales':
          valA = a.sales;
          valB = b.sales;
          break;
        case 'salesshare':
          valA = a.salesSharePercent;
          valB = b.salesSharePercent;
          break;
        case 'share':
          valA = a.sharePercent;
          valB = b.sharePercent;
          break;
        case 'cost':
          valA = a.cost;
          valB = b.cost;
          break;
        case 'margin':
          valA = a.marginPercent;
          valB = b.marginPercent;
          break;
        case 'units':
          valA = a.unitsSold;
          valB = b.unitsSold;
          break;
        case 'profit':
        default:
          valA = a.profit;
          valB = b.profit;
          break;
      }
      if (valA === null && valB === null) return 0;
      if (valA === null) return 1;
      if (valB === null) return -1;
      return mult * (valA - valB);
    });

    const page = Math.max(1, Number(dto.page) || 1);
    const pageSize = Math.min(5000, Math.max(1, Number(dto.pageSize) || 50));
    const total = itemsWithShares.length;
    const pagedItems = itemsWithShares.slice((page - 1) * pageSize, page * pageSize);

    return {
      items: pagedItems.map((i) => ({
        productId: i.productId,
        name: i.name,
        category: i.category,
        categoryId: i.categoryId,
        unit: i.unit,
        unitsSold: i.unitsSold,
        sales: i.sales,
        cost: i.cost,
        profit: i.profit,
        marginPercent: i.marginPercent,
        salesSharePercent: i.salesSharePercent,
        sharePercent: i.sharePercent,
        hasCost: i.hasCost,
      })),
      page,
      pageSize,
      total,
      totals,
    };
  }

  async getIncomeStatement(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const r2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
    const d2 = (x: Prisma.Decimal) =>
      x.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();

    const bizConfig = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { pedidosYaChannelEnabled: true, deliveryTaxable: true, taxEnabled: true },
    });
    const pedidosYaEnabled = Boolean(bizConfig?.pedidosYaChannelEnabled);
    const isDeliveryTaxable = bizConfig?.deliveryTaxable ?? Boolean(bizConfig?.taxEnabled);

    const computeSalesAgg = async (fromDt: Date, toDt: Date) => {
      const [rows, deliv] = await Promise.all([
        this.prisma.$queryRaw<any[]>`
          SELECT
            COALESCE(SUM(GREATEST(0, s.subtotal - COALESCE(deliv_items.deliv_subtotal, 0))), 0)::float AS "prodGrossSales",
            COALESCE(SUM(GREATEST(0, s."discountAmount" - (
              CASE
                WHEN COALESCE(deliv_items.deliv_discount, 0) > 0 THEN COALESCE(deliv_items.deliv_discount, 0)
                WHEN s.subtotal > 0 THEN s."discountAmount" * (COALESCE(deliv_items.deliv_subtotal, 0) / s.subtotal)
                ELSE 0
              END
            ))), 0)::float AS "prodDiscounts",
            COALESCE(SUM(refunds.net_refund), 0)::float AS "returns",
            COALESCE(SUM(GREATEST(0,
              GREATEST(0, s.subtotal - COALESCE(deliv_items.deliv_subtotal, 0))
              - GREATEST(0, s."discountAmount" - (
                  CASE
                    WHEN COALESCE(deliv_items.deliv_discount, 0) > 0 THEN COALESCE(deliv_items.deliv_discount, 0)
                    WHEN s.subtotal > 0 THEN s."discountAmount" * (COALESCE(deliv_items.deliv_subtotal, 0) / s.subtotal)
                    ELSE 0
                  END
                ))
              - COALESCE(refunds.net_refund, 0)
            )), 0)::float AS "prodNetSales",
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
          LEFT JOIN (
            SELECT
              si."saleId",
              COALESCE(SUM(si.subtotal), 0) AS deliv_subtotal,
              COALESCE(SUM(si."manualDiscountShare"), 0) AS deliv_discount
            FROM pos_sale_items si
            JOIN pos_sales ps ON ps.id = si."saleId"
            WHERE ps."businessId" = ${businessId}
              AND si."productId" IS NULL
              AND (
                LOWER(si."productName") LIKE '%envío%'
                OR LOWER(si."productName") LIKE '%envio%'
                OR LOWER(si."productName") LIKE '%domicilio%'
              )
            GROUP BY si."saleId"
          ) deliv_items ON deliv_items."saleId" = s.id
          WHERE s."businessId" = ${businessId}
            AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
            AND (s."createdAt" AT TIME ZONE 'UTC') >= ${fromDt} AND (s."createdAt" AT TIME ZONE 'UTC') <= ${toDt};
        `,
        this.computeDeliveryRevenueDetails(businessId, fromDt, toDt, isDeliveryTaxable),
      ]);
      const row = rows[0] || {};
      const deliveryRevenue = d2(deliv.total);
      const offlineDeliveryRevenue = d2(deliv.offlineTotal);
      const grossSales = r2((row.prodGrossSales || 0) + deliveryRevenue);
      const discounts = r2(row.prodDiscounts || 0);
      const returns = r2(row.returns || 0);
      const netSales = r2((row.prodNetSales || 0) + deliveryRevenue);
      const taxableSales = r2(row.taxableSales || 0);
      const exemptSales = r2((row.exemptSales || 0) + offlineDeliveryRevenue);
      const taxAmount = r2(row.taxAmount || 0);
      return {
        grossSales,
        discounts,
        returns,
        netSales,
        deliveryRevenue,
        taxableSales,
        exemptSales,
        taxAmount,
      };
    };

    const computeProfitMetrics = async (fromDt: Date, toDt: Date) => {
      const rows: any[] = await this.prisma.$queryRaw`
        WITH RECURSIVE ${this.getCostResolutionSql(businessId)},
        ${this.getProfitItemsSql(businessId, fromDt, toDt)}
        SELECT
          cost_source AS source,
          COALESCE(SUM(line_revenue), 0)::float AS revenue,
          COALESCE(SUM(unit_cost * net_qty), 0)::float AS cost
        FROM item_sales
        WHERE net_qty > 0
        GROUP BY cost_source;
      `;

      let totalRevenueAcc = 0;
      let coveredRevenueAcc = 0;
      let totalCostAcc = 0;
      for (const r of rows) {
        const rev = Number(r.revenue || 0);
        const cst = Number(r.cost || 0);
        totalRevenueAcc += rev;
        if (r.source && r.source !== 'UNKNOWN') {
          coveredRevenueAcc += rev;
          totalCostAcc += cst;
        }
      }

      const totalRevenue = r2(totalRevenueAcc);
      const coveredRevenue = r2(coveredRevenueAcc);
      const coveragePercent = totalRevenue > 0
        ? Math.round((coveredRevenue / totalRevenue) * 10000) / 100
        : 100;

      const totalCost = r2(totalCostAcc);
      return {
        totalRevenue,
        coveredRevenue,
        coveragePercent,
        totalCost,
      };
    };

    const computeExpensesAgg = (fromDt: Date, toDt: Date) => this.computeExpensesAgg(businessId, fromDt, toDt);

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

    const [currentSales, currentMetrics, currentExpenses, currentInterestIncome, currentPyFees] = await Promise.all([
      computeSalesAgg(startDate, endDate),
      computeProfitMetrics(startDate, endDate),
      computeExpensesAgg(startDate, endDate),
      computeInterestIncome(startDate, endDate),
      this.aggregatePedidosYaFees(businessId, startDate, endDate),
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

    const currComm = d2(currentPyFees.commission);
    const currTax = d2(currentPyFees.tax);
    const currFeesTotal = d2(currentPyFees.commission.plus(currentPyFees.tax));
    const includePedidosYa = pedidosYaEnabled || currentPyFees.hasOrders || currFeesTotal > 0;
    const channelFees = includePedidosYa
      ? { commission: currComm, tax: currTax, total: currFeesTotal }
      : null;

    const costOfGoodsSold = currentMetrics.totalCost;
    const grossProfit = r2(currentSales.netSales - costOfGoodsSold - currFeesTotal);
    const grossMarginPercent = currentSales.netSales > 0
      ? Math.round((grossProfit / currentSales.netSales) * 10000) / 100
      : 0;

    const operatingProfit = r2(grossProfit - currentExpenses.total);
    const operatingMarginPercent = currentSales.netSales > 0
      ? Math.round((operatingProfit / currentSales.netSales) * 10000) / 100
      : 0;

    const interestIncome = currentInterestIncome;
    const netProfit = r2(operatingProfit + interestIncome);

    // 183d / 264d: Ventas con costo cubierto vs ventas sin costo (el envío nunca entra en uncoveredRevenue)
    const productNetSales = Math.max(0, r2(currentSales.netSales - currentSales.deliveryRevenue));
    const coveredProductRevenue = missing.length === 0
      ? productNetSales
      : Math.min(productNetSales, Math.max(0, r2(currentMetrics.coveredRevenue)));
    const uncoveredRevenue = Math.max(0, r2(productNetSales - coveredProductRevenue));
    const coveredRevenue = Math.max(0, r2(currentSales.netSales - uncoveredRevenue));

    const coveragePercent = currentSales.netSales > 0
      ? Math.round((coveredRevenue / currentSales.netSales) * 10000) / 100
      : 100;

    const isPartial = coveragePercent < 100 || missing.length > 0;

    const [prevSales, prevMetrics, prevExpenses, prevInterestIncome, prevPyFees] = await Promise.all([
      computeSalesAgg(range.previous.from, range.previous.to),
      computeProfitMetrics(range.previous.from, range.previous.to),
      computeExpensesAgg(range.previous.from, range.previous.to),
      computeInterestIncome(range.previous.from, range.previous.to),
      this.aggregatePedidosYaFees(businessId, range.previous.from, range.previous.to),
    ]);

    const prevFeesTotal = d2(prevPyFees.commission.plus(prevPyFees.tax));
    const prevGrossProfit = r2(prevSales.netSales - prevMetrics.totalCost - prevFeesTotal);
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
      channelFees,
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
      const fees = this.calculatePedidosYaOrderFees(s);
      const tot = fees.effectiveTotal;
      const comm = fees.commission;
      const tx = fees.tax;
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
        const fees = this.calculatePedidosYaOrderFees(s);
        const tot = fees.effectiveTotal;
        const refundSum = fees.refundSum;
        const commPct = fees.commPct;
        const taxPct = fees.taxPct;
        const comm = fees.commission;
        const tx = fees.tax;
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

  /**
   * 263a - Reporte consolidado de propinas ACTIVE (sin mezclar con ventas ni IVA).
   */
  async getTipsReport(
    businessId: string,
    filters: {
      period?: string;
      from?: string;
      to?: string;
      waiterId?: string;
      paymentMethod?: string;
      cashRegisterId?: string;
    } = {},
  ) {
    const range = this.resolveDateRange(filters.period, filters.from, filters.to);
    const where: Prisma.SaleTipWhereInput = {
      businessId,
      status: 'ACTIVE',
      createdAt: {
        gte: range.current.from,
        lte: range.current.to,
      },
    };

    if (filters.waiterId) {
      where.waiterId = filters.waiterId;
    }
    if (filters.paymentMethod) {
      const pm = filters.paymentMethod.toUpperCase().trim();
      if (!['EFECTIVO', 'TARJETA', 'TRANSFERENCIA'].includes(pm)) {
        throw new BadRequestException('Método de pago inválido para filtro de propinas');
      }
      where.paymentMethod = pm;
    }
    if (filters.cashRegisterId) {
      where.cashRegisterId = filters.cashRegisterId;
    }

    const tips = await this.prisma.saleTip.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    let baseTotalDec = new Prisma.Decimal(0);
    const byMethodMap = new Map<string, { paymentMethod: string; count: number; baseTotal: Prisma.Decimal }>();
    const byCurrencyMap = new Map<string, { currency: string; count: number; amount: Prisma.Decimal; baseTotal: Prisma.Decimal }>();
    const byWaiterMap = new Map<string, { waiterId: string | null; waiterName: string; count: number; baseTotal: Prisma.Decimal }>();

    for (const t of tips) {
      const amtDec = new Prisma.Decimal(t.amount.toString());
      const baseDec = new Prisma.Decimal(t.amountBase.toString());
      const method = (t.paymentMethod || '').toUpperCase();
      const currency = (t.currency || 'NIO').toUpperCase();

      baseTotalDec = baseTotalDec.plus(baseDec);

      let mEntry = byMethodMap.get(method);
      if (!mEntry) {
        mEntry = { paymentMethod: method, count: 0, baseTotal: new Prisma.Decimal(0) };
        byMethodMap.set(method, mEntry);
      }
      mEntry.count += 1;
      mEntry.baseTotal = mEntry.baseTotal.plus(baseDec);

      let cEntry = byCurrencyMap.get(currency);
      if (!cEntry) {
        cEntry = { currency, count: 0, amount: new Prisma.Decimal(0), baseTotal: new Prisma.Decimal(0) };
        byCurrencyMap.set(currency, cEntry);
      }
      cEntry.count += 1;
      cEntry.amount = cEntry.amount.plus(amtDec);
      cEntry.baseTotal = cEntry.baseTotal.plus(baseDec);

      const wKey = t.waiterId || (t.waiterName ? `name:${t.waiterName}` : 'SIN_MESERO');
      let wEntry = byWaiterMap.get(wKey);
      if (!wEntry) {
        wEntry = {
          waiterId: t.waiterId || null,
          waiterName: t.waiterName || 'Sin mesero',
          count: 0,
          baseTotal: new Prisma.Decimal(0),
        };
        byWaiterMap.set(wKey, wEntry);
      }
      wEntry.count += 1;
      wEntry.baseTotal = wEntry.baseTotal.plus(baseDec);
    }

    return {
      period: {
        from: range.current.fromIso,
        to: range.current.toIso,
      },
      totals: {
        count: tips.length,
        baseTotal: Number(baseTotalDec.toDecimalPlaces(2)),
        byMethod: Array.from(byMethodMap.values()).map((m) => ({
          paymentMethod: m.paymentMethod,
          count: m.count,
          baseTotal: Number(m.baseTotal.toDecimalPlaces(2)),
        })),
        byCurrency: Array.from(byCurrencyMap.values()).map((c) => ({
          currency: c.currency,
          count: c.count,
          amount: Number(c.amount.toDecimalPlaces(2)),
          baseTotal: Number(c.baseTotal.toDecimalPlaces(2)),
        })),
      },
      byWaiter: Array.from(byWaiterMap.values())
        .map((w) => ({
          waiterId: w.waiterId,
          waiterName: w.waiterName,
          count: w.count,
          baseTotal: Number(w.baseTotal.toDecimalPlaces(2)),
        }))
        .sort((a, b) => b.baseTotal - a.baseTotal),
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
