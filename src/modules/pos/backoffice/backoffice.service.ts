import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BackofficeSalesQueryDto,
  BackofficeDateRangeDto,
  BackofficeInventoryQueryDto,
  BackofficeCashRegisterQueryDto,
} from './dto/backoffice-query.dto';

@Injectable()
export class BackofficeService {
  private readonly logger = new Logger(BackofficeService.name);

  constructor(private readonly prisma: PrismaService) {}

  private round2(num: number): number {
    return Math.round((num + Number.EPSILON) * 100) / 100;
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
   */
  async getDashboard(businessId: string) {
    const now = new Date();

    // Rango Hoy (00:00:00 a now) vs Ayer (mismo día entero o hasta la hora)
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayEnd = new Date(todayEnd.getTime() - 24 * 60 * 60 * 1000);

    // Rango Semana (últimos 7 días) vs Semana anterior (7 días previos)
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const prevWeekEnd = new Date(weekStart.getTime());

    // Rango Mes (desde día 1 del mes actual) vs Mes anterior
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const activeSaleStatuses = [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_RETURNED, SaleStatus.RETURNED];

    // Helper para calcular métricas de un rango
    const computePeriodMetrics = async (startDate: Date, endDate: Date) => {
      const sales = await this.prisma.sale.findMany({
        where: {
          businessId,
          status: { in: activeSaleStatuses },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: { returns: { select: { refundAmount: true } } },
      });

      const salesCount = sales.length;
      let totalRevenue = 0;
      for (const s of sales) {
        const refundTotal = (s.returns || []).reduce((acc, r) => acc + (r.refundAmount || 0), 0);
        totalRevenue += Math.max(0, s.total - refundTotal);
      }

      totalRevenue = this.round2(totalRevenue);
      const averageTicket = salesCount > 0 ? this.round2(totalRevenue / salesCount) : 0;
      return { totalRevenue, salesCount, averageTicket };
    };

    const [todayMetrics, yesterdayMetrics] = await Promise.all([
      computePeriodMetrics(todayStart, todayEnd),
      computePeriodMetrics(yesterdayStart, yesterdayEnd),
    ]);

    const [weekMetrics, prevWeekMetrics] = await Promise.all([
      computePeriodMetrics(weekStart, now),
      computePeriodMetrics(prevWeekStart, prevWeekEnd),
    ]);

    const [monthMetrics, prevMonthMetrics] = await Promise.all([
      computePeriodMetrics(monthStart, now),
      computePeriodMetrics(prevMonthStart, prevMonthEnd),
    ]);

    // Calcular crecimiento/comparación
    const computeComparison = (current: { totalRevenue: number; salesCount: number; averageTicket: number }, prev: { totalRevenue: number; salesCount: number; averageTicket: number }) => {
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

    // Desglose de métodos de pago del mes actual (o general)
    const monthSales = await this.prisma.sale.findMany({
      where: {
        businessId,
        status: { in: activeSaleStatuses },
        createdAt: { gte: monthStart, lte: now },
      },
      include: {
        returns: { select: { refundAmount: true, refundMethod: true } },
        payments: true,
      },
    });

    const paymentMethods = {
      efectivo: 0,
      tarjeta: 0,
      transferencia: 0,
      otros: 0,
    };

    for (const sale of monthSales) {
      const refundTotal = (sale.returns || []).reduce((acc, r) => acc + (r.refundAmount || 0), 0);
      const netTotal = Math.max(0, sale.total - refundTotal);

      if (sale.payments && sale.payments.length > 0) {
        for (const p of sale.payments) {
          const method = (p.method || '').toUpperCase();
          const amt = Number(p.amountBase || p.amount || 0);
          if (method === 'EFECTIVO' || method === 'CASH') paymentMethods.efectivo += amt;
          else if (method === 'TARJETA' || method === 'CARD') paymentMethods.tarjeta += amt;
          else if (method === 'TRANSFERENCIA' || method === 'TRANSFER') paymentMethods.transferencia += amt;
          else paymentMethods.otros += amt;
        }
      } else {
        const method = (sale.paymentMethod || '').toUpperCase();
        if (method === 'EFECTIVO' || method === 'CASH') paymentMethods.efectivo += netTotal;
        else if (method === 'TARJETA' || method === 'CARD') paymentMethods.tarjeta += netTotal;
        else if (method === 'TRANSFERENCIA' || method === 'TRANSFER') paymentMethods.transferencia += netTotal;
        else paymentMethods.otros += netTotal;
      }
    }

    paymentMethods.efectivo = this.round2(paymentMethods.efectivo);
    paymentMethods.tarjeta = this.round2(paymentMethods.tarjeta);
    paymentMethods.transferencia = this.round2(paymentMethods.transferencia);
    paymentMethods.otros = this.round2(paymentMethods.otros);

    // Obtener información de suscripción y negocio
    const [business, posSub] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { currency: true, salonProfile: true },
      }),
      this.prisma.businessProductSubscription.findFirst({
        where: { businessId, productType: 'POS' },
        select: { backofficeTier: true as any },
      }),
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
