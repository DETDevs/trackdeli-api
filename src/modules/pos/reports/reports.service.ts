import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  async getSalesSummary(businessId: string, from?: string, to?: string) {
    const where: any = { businessId, status: "COMPLETED" };
    const dateRange = this.buildDateRange(from, to);
    if (Object.keys(dateRange).length) where.createdAt = dateRange;

    const sales = await this.prisma.sale.findMany({ where, include: { items: true } });

    const totalSales = sales.length;
    const totalRevenue = sales.reduce((sum, s) => sum + s.total, 0);
    const totalDiscount = sales.reduce((sum, s) => sum + s.discountAmount, 0);
    const totalTax = sales.reduce((sum, s) => sum + s.taxAmount, 0);

    const byPaymentMethod: Record<string, number> = {};
    for (const sale of sales) {
      byPaymentMethod[sale.paymentMethod] = (byPaymentMethod[sale.paymentMethod] || 0) + sale.total;
    }

    const byDay = this.groupByDay(sales);

    this.logger.log(`[getSalesSummary] businessId=${businessId} ventas=${totalSales} total=${totalRevenue.toFixed(2)}`);

    return {
      period: { from, to },
      totalSales,
      totalRevenue,
      totalDiscount,
      totalTax,
      netRevenue: totalRevenue - totalDiscount,
      averageTicket: totalSales > 0 ? totalRevenue / totalSales : 0,
      byPaymentMethod,
      byDay,
    };
  }

  private groupByDay(sales: any[]) {
    const map = new Map<string, { count: number; revenue: number }>();
    for (const sale of sales) {
      const day = sale.createdAt.toISOString().split("T")[0];
      const existing = map.get(day) || { count: 0, revenue: 0 };
      existing.count += 1;
      existing.revenue += sale.total;
      map.set(day, existing);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, data]) => ({ date, ...data }));
  }

  async getTopProducts(businessId: string, from?: string, to?: string, limit = 10) {
    const saleWhere: any = { businessId, status: "COMPLETED" };
    const dateRange = this.buildDateRange(from, to);
    if (Object.keys(dateRange).length) saleWhere.createdAt = dateRange;

    const items = await this.prisma.saleItem.findMany({
      where: { sale: saleWhere },
      include: { product: { select: { category: { select: { name: true } } } } },
    });

    const productMap = new Map<string, { name: string; category: string; quantity: number; revenue: number; times: number }>();
    for (const item of items) {
      const key = item.productName;
      const existing = productMap.get(key) || {
        name: item.productName,
        category: item.product?.category?.name || "Sin categoría",
        quantity: 0, revenue: 0, times: 0,
      };
      existing.quantity += item.quantity;
      existing.revenue += item.subtotal;
      existing.times += 1;
      productMap.set(key, existing);
    }

    return Array.from(productMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  async getDaily(businessId: string) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const sales = await this.prisma.sale.findMany({
      where: { businessId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
    });

    const byHour = new Map<number, { count: number; revenue: number }>();
    for (let h = 0; h < 24; h++) byHour.set(h, { count: 0, revenue: 0 });

    for (const sale of sales) {
      const hour = sale.createdAt.getHours();
      const existing = byHour.get(hour)!;
      existing.count += 1;
      existing.revenue += sale.total;
    }

    return Array.from(byHour.entries()).map(([hour, data]) => ({ hour, ...data }));
  }

  async getStockAlerts(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId, isActive: true, trackStock: true },
      include: { category: true },
    });
    return products.filter((p) => p.stock <= p.minStock).sort((a, b) => a.stock - b.stock);
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

  async getOverview(businessId: string, period?: string, from?: string, to?: string) {
    let dateFrom = from;
    let dateTo = to;
    if (period && !from && !to) {
      const now = new Date();
      if (period === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        dateFrom = start.toISOString();
      } else if (period === 'week') {
        const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        dateFrom = start.toISOString();
      } else if (period === 'month') {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        dateFrom = start.toISOString();
      } else if (period === 'year') {
        const start = new Date(now.getFullYear(), 0, 1);
        dateFrom = start.toISOString();
      }
    }

    const summary = await this.getSalesSummary(businessId, dateFrom, dateTo);
    const topProducts = await this.getTopProducts(businessId, dateFrom, dateTo, 5);
    const lowStockProducts = await this.getStockAlerts(businessId);

    const totalCash = summary.byPaymentMethod['EFECTIVO'] || 0;
    const totalCard = summary.byPaymentMethod['TARJETA'] || 0;
    const totalTransfer = summary.byPaymentMethod['TRANSFERENCIA'] || 0;

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
    };
  }
}
