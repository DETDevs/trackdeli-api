import { BadRequestException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { BusinessProductType, CreditAccountStatus, PosPaymentMethod } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { BusinessProductsService } from "../../business-products/business-products.service";

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

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
      throw new ForbiddenException('Este negocio no tiene Cartera de Cobro contratada');
    }
  }

  private buildDateRange(from?: string, to?: string) {
    const range: any = {};
    if (from) {
      range.gte = from.includes('T') ? new Date(from) : new Date(`${from}T00:00:00.000Z`);
    }
    if (to) {
      range.lte = to.includes('T') ? new Date(to) : new Date(`${to}T23:59:59.999Z`);
    }
    return range;
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
        COALESCE(SUM(GREATEST(0, s.subtotal - s."discountAmount" - COALESCE(refunds.net_refund, 0))), 0)::float AS "netRevenue"
      FROM pos_sales s
      LEFT JOIN (
        SELECT "saleId", SUM("refundAmount") AS total_refund, SUM("taxRefunded") AS tax_refund, SUM("refundAmount" - COALESCE("taxRefunded", 0)) AS net_refund
        FROM pos_sale_returns
        WHERE "businessId" = ${businessId}
        GROUP BY "saleId"
      ) refunds ON refunds."saleId" = s.id
      WHERE s."businessId" = ${businessId}
        AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
        AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
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
        AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0)
      GROUP BY s."paymentMethod";
    `;

    const byDayRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        TO_CHAR(s."createdAt" AT TIME ZONE 'America/Managua', 'YYYY-MM-DD') AS date,
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
        AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
        AND s.total > COALESCE(refunds.total_refund, 0)
      GROUP BY TO_CHAR(s."createdAt" AT TIME ZONE 'America/Managua', 'YYYY-MM-DD')
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

    this.logger.log(`[getSalesSummary] businessId=${businessId} ventas=${totalSales} total=${totalRevenue.toFixed(2)}`);

    return {
      period: { from: range.current.fromIso, to: range.current.toIso },
      totalSales,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalDiscount: Math.round(totalDiscount * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      netRevenue: Math.round(netRevenue * 100) / 100,
      averageTicket: totalSales > 0 ? Math.round((totalRevenue / totalSales) * 100) / 100 : 0,
      byPaymentMethod,
      byDay,
    };
  }

  async getTopProducts(businessId: string, from?: string, to?: string, limit = 10) {
    const dateRange = this.buildDateRange(from, to);
    let startDate: Date, endDate: Date;
    if (Object.keys(dateRange).length) {
      startDate = new Date(dateRange.gte);
      endDate = new Date(dateRange.lte);
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
          AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
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
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

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
      const hour = sale.createdAt.getHours();
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
    const MANAGUA_OFFSET_MS = -6 * 60 * 60 * 1000;

    const createUtcDateFromManagua = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) => {
      return new Date(Date.UTC(year, month, day, hour + 6, minute, second, ms));
    };

    const nowUtc = new Date();
    const nowManagua = new Date(nowUtc.getTime() + MANAGUA_OFFSET_MS);
    const y = nowManagua.getUTCFullYear();
    const m = nowManagua.getUTCMonth();
    const d = nowManagua.getUTCDate();

    let curFrom: Date;
    let curTo: Date;
    let prevFrom: Date;
    let prevTo: Date;

    if (from && to) {
      if (from.includes('T')) {
        curFrom = new Date(from);
      } else {
        const [fy, fm, fd] = from.split('-').map(Number);
        curFrom = createUtcDateFromManagua(fy, fm - 1, fd, 0, 0, 0, 0);
      }

      if (to.includes('T')) {
        curTo = new Date(to);
      } else {
        const [ty, tm, td] = to.split('-').map(Number);
        curTo = createUtcDateFromManagua(ty, tm - 1, td, 23, 59, 59, 999);
      }

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
    } else if (period === 'week') {
      curTo = nowUtc;
      curFrom = new Date(nowUtc.getTime() - 7 * 24 * 60 * 60 * 1000);
      prevTo = curFrom;
      prevFrom = new Date(prevTo.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === 'month') {
      curFrom = createUtcDateFromManagua(y, m, 1, 0, 0, 0, 0);
      curTo = nowUtc;
      const prevMonthYear = m === 0 ? y - 1 : y;
      const prevMonth = m === 0 ? 11 : m - 1;
      prevFrom = createUtcDateFromManagua(prevMonthYear, prevMonth, 1, 0, 0, 0, 0);
      prevTo = new Date(curFrom.getTime() - 1);
    } else if (period === 'year') {
      curFrom = createUtcDateFromManagua(y, 0, 1, 0, 0, 0, 0);
      curTo = nowUtc;
      prevFrom = createUtcDateFromManagua(y - 1, 0, 1, 0, 0, 0, 0);
      prevTo = new Date(curFrom.getTime() - 1);
    } else {
      // 'today' is default
      curFrom = createUtcDateFromManagua(y, m, d, 0, 0, 0, 0);
      curTo = createUtcDateFromManagua(y, m, d, 23, 59, 59, 999);
      prevFrom = createUtcDateFromManagua(y, m, d - 1, 0, 0, 0, 0);
      prevTo = createUtcDateFromManagua(y, m, d - 1, 23, 59, 59, 999);
    }

    return {
      current: { from: curFrom, to: curTo, fromIso: curFrom.toISOString(), toIso: curTo.toISOString() },
      previous: { from: prevFrom, to: prevTo, fromIso: prevFrom.toISOString(), toIso: prevTo.toISOString() },
    };
  }

  async getOverview(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const summary = await this.getSalesSummary(businessId, range.current.fromIso, range.current.toIso);
    const prevSummary = await this.getSalesSummary(businessId, range.previous.fromIso, range.previous.toIso);
    const topProducts = await this.getTopProducts(businessId, range.current.fromIso, range.current.toIso, 5);
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
        originalAmount: acc.originalAmount,
        balance: acc.balance,
        dueDate: acc.dueDate,
        daysOverdue,
        status: acc.status,
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
        originalAmount: acc.originalAmount,
        balance: acc.balance,
        dueDate: acc.dueDate,
        isOverdue,
        status: acc.status,
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

    const computeProfitMetrics = async (fromDt: Date, toDt: Date) => {
      const result: any[] = await this.prisma.$queryRaw`
        WITH recipe_summary AS (
          SELECT
            rc."parentProductId",
            SUM(rc.quantity * comp.cost) AS recipe_cost,
            COUNT(CASE WHEN comp.cost IS NULL THEN 1 END) AS missing_comp_cost_count,
            COUNT(rc.id) AS total_components
          FROM pos_product_components rc
          JOIN pos_products comp ON comp.id = rc."componentProductId"
          GROUP BY rc."parentProductId"
        ),
        product_costs AS (
          SELECT
            p.id AS product_id,
            CASE
              WHEN p.cost IS NOT NULL THEN p.cost::float
              WHEN rs.total_components > 0 AND rs.missing_comp_cost_count = 0 THEN rs.recipe_cost::float
              ELSE NULL
            END AS unit_cost
          FROM pos_products p
          LEFT JOIN recipe_summary rs ON rs."parentProductId" = p.id
          WHERE p."businessId" = ${businessId}
        ),
        item_sales AS (
          SELECT
            i.id,
            i."productId",
            i."productName",
            GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0))::float AS net_qty,
            (
              ((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))
              * (CASE WHEN s.subtotal > 0 THEN (1 - (s."discountAmount" / s.subtotal)) ELSE 1 END)
            )::float AS line_revenue,
            pc.unit_cost
          FROM pos_sale_items i
          JOIN pos_sales s ON s.id = i."saleId"
          LEFT JOIN product_costs pc ON pc.product_id = i."productId"
          WHERE s."businessId" = ${businessId}
            AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
            AND s."createdAt" >= ${fromDt} AND s."createdAt" <= ${toDt}

          UNION ALL

          SELECT
            s.id AS id,
            NULL AS "productId",
            'Sin categoría' AS "productName",
            1::float AS net_qty,
            GREATEST(0, s.subtotal - s."discountAmount" - COALESCE((
              SELECT SUM("refundAmount" - COALESCE("taxRefunded", 0))
              FROM pos_sale_returns r
              WHERE r."saleId" = s.id
            ), 0))::float AS line_revenue,
            NULL AS unit_cost
          FROM pos_sales s
          WHERE s."businessId" = ${businessId}
            AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
            AND s."createdAt" >= ${fromDt} AND s."createdAt" <= ${toDt}
            AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i."saleId" = s.id)
        )
        SELECT
          COALESCE(SUM(line_revenue), 0)::float AS "totalRevenue",
          COALESCE(SUM(CASE WHEN unit_cost IS NOT NULL THEN line_revenue ELSE 0 END), 0)::float AS "coveredRevenue",
          COALESCE(SUM(CASE WHEN unit_cost IS NULL THEN line_revenue ELSE 0 END), 0)::float AS "uncoveredRevenue",
          COALESCE(SUM(CASE WHEN unit_cost IS NOT NULL THEN unit_cost * net_qty ELSE 0 END), 0)::float AS "totalCost"
        FROM item_sales
        WHERE net_qty > 0;
      `;

      const totalRevenue = Math.round((result[0]?.totalRevenue || 0) * 100) / 100;
      const coveredRevenue = Math.round((result[0]?.coveredRevenue || 0) * 100) / 100;
      const uncoveredRevenue = Math.round((result[0]?.uncoveredRevenue || 0) * 100) / 100;
      const coveragePercent = totalRevenue > 0
        ? Math.round((coveredRevenue / totalRevenue) * 10000) / 100
        : 0;

      let totalCost: number | null = null;
      let estimatedProfit: number | null = null;
      let marginPercent: number | null = null;

      if (coveragePercent > 0 && coveredRevenue > 0) {
        totalCost = Math.round((result[0]?.totalCost || 0) * 100) / 100;
        estimatedProfit = Math.round((coveredRevenue - totalCost) * 100) / 100;
        marginPercent = Math.round(((coveredRevenue - totalCost) / coveredRevenue) * 10000) / 100;
      }

      return {
        totalRevenue,
        coveredRevenue,
        uncoveredRevenue,
        coveragePercent,
        totalCost,
        estimatedProfit,
        marginPercent,
      };
    };

    const currentMetrics = await computeProfitMetrics(startDate, endDate);

    const missing: any[] = await this.prisma.$queryRaw`
      WITH recipe_summary AS (
        SELECT
          rc."parentProductId",
          SUM(rc.quantity * comp.cost) AS recipe_cost,
          COUNT(CASE WHEN comp.cost IS NULL THEN 1 END) AS missing_comp_cost_count,
          COUNT(rc.id) AS total_components
        FROM pos_product_components rc
        JOIN pos_products comp ON comp.id = rc."componentProductId"
        GROUP BY rc."parentProductId"
      ),
      product_costs AS (
        SELECT
          p.id AS product_id,
          CASE
            WHEN p.cost IS NOT NULL THEN p.cost::float
            WHEN rs.total_components > 0 AND rs.missing_comp_cost_count = 0 THEN rs.recipe_cost::float
            ELSE NULL
          END AS unit_cost
        FROM pos_products p
        LEFT JOIN recipe_summary rs ON rs."parentProductId" = p.id
        WHERE p."businessId" = ${businessId}
      ),
      item_sales AS (
        SELECT
          i."productId",
          i."productName",
          GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0))::float AS net_qty,
          (
            ((CASE WHEN i.quantity > 0 THEN i.subtotal / i.quantity ELSE i."unitPrice" END) * GREATEST(0, i.quantity - COALESCE(i."returnedQty", 0)))
            * (CASE WHEN s.subtotal > 0 THEN (1 - (s."discountAmount" / s.subtotal)) ELSE 1 END)
          )::float AS line_revenue,
          pc.unit_cost
        FROM pos_sale_items i
        JOIN pos_sales s ON s.id = i."saleId"
        LEFT JOIN product_costs pc ON pc.product_id = i."productId"
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}

        UNION ALL

        SELECT
          NULL AS "productId",
          'Sin categoría' AS "productName",
          1::float AS net_qty,
          GREATEST(0, s.subtotal - s."discountAmount" - COALESCE((
            SELECT SUM("refundAmount" - COALESCE("taxRefunded", 0))
            FROM pos_sale_returns r
            WHERE r."saleId" = s.id
          ), 0))::float AS line_revenue,
          NULL AS unit_cost
        FROM pos_sales s
        WHERE s."businessId" = ${businessId}
          AND s.status IN ('COMPLETED', 'PARTIALLY_RETURNED', 'RETURNED')
          AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
          AND NOT EXISTS (SELECT 1 FROM pos_sale_items i WHERE i."saleId" = s.id)
      )
      SELECT
        COALESCE("productId", 'unknown') AS id,
        "productName" AS name,
        SUM(net_qty)::float AS "quantitySold",
        SUM(line_revenue)::float AS "totalSold"
      FROM item_sales
      WHERE unit_cost IS NULL AND net_qty > 0
      GROUP BY "productId", "productName"
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

  async getSalesByTime(businessId: string, period?: string, from?: string, to?: string) {
    const range = this.resolveDateRange(period, from, to);
    const startDate = range.current.from;
    const endDate = range.current.to;

    const hoursRaw: any[] = await this.prisma.$queryRaw`
      SELECT
        EXTRACT(HOUR FROM s."createdAt" AT TIME ZONE 'America/Managua')::int AS hour,
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
        AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
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
        EXTRACT(DOW FROM s."createdAt" AT TIME ZONE 'America/Managua')::int AS dow,
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
        AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
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
          AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}

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
          AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
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
          ("voidedAt" >= ${startDate} AND "voidedAt" <= ${endDate})
          OR ("voidedAt" IS NULL AND "createdAt" >= ${startDate} AND "createdAt" <= ${endDate})
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
        AND "createdAt" >= ${startDate} AND "createdAt" <= ${endDate};
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
        AND "createdAt" >= ${startDate} AND "createdAt" <= ${endDate};
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
        AND "closedAt" >= ${startDate} AND "closedAt" <= ${endDate};
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
        AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
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
        AND s."createdAt" >= ${startDate} AND s."createdAt" <= ${endDate}
        AND (s."workshopVehicleId" IS NOT NULL OR p."trackStock" = false OR c.name ILIKE '%servicio%')
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
        AND COALESCE(o."closedAt", o."createdAt") >= ${startDate}
        AND COALESCE(o."closedAt", o."createdAt") <= ${endDate}
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
        AND COALESCE(o."closedAt", o."createdAt") >= ${startDate}
        AND COALESCE(o."closedAt", o."createdAt") <= ${endDate}
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
