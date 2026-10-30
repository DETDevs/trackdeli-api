import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CreatePedidosYaSettlementDto,
  PedidosYaSettlementQueryDto,
} from './dto/pedidosya-settlement.dto';
import { buildBusinessDateRange } from '../../../common/utils/date.util';

@Injectable()
export class PedidosYaSettlementService {
  private readonly logger = new Logger(PedidosYaSettlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSettlementSummary(
    businessId: string,
    query?: PedidosYaSettlementQueryDto,
  ) {
    const where: any = {
      businessId,
      channel: 'PEDIDOSYA',
      status: 'COMPLETED',
    };

    if (query?.from || query?.to) {
      where.createdAt = buildBusinessDateRange(query.from, query.to);
    }

    if (query?.status && query.status !== 'ALL') {
      where.pedidosYaSettlementStatus = query.status.toUpperCase();
    }

    const sales = await this.prisma.sale.findMany({
      where,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        createdAt: true,
        total: true,
        pedidosYaOrderNumber: true,
        pedidosYaPaymentMode: true,
        pedidosYaCommissionPct: true,
        pedidosYaTaxPct: true,
        pedidosYaCommissionAmount: true,
        pedidosYaTaxAmount: true,
        pedidosYaNetPayout: true,
        pedidosYaSettlementStatus: true,
        pedidosYaSettlementId: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const appSales = sales.filter((s) => (s.pedidosYaPaymentMode || 'APP') === 'APP');
    const cashSales = sales.filter((s) => s.pedidosYaPaymentMode === 'EFECTIVO');

    const appGross = Math.round(appSales.reduce((sum, s) => sum + s.total, 0) * 100) / 100;
    const appCommission = Math.round(appSales.reduce((sum, s) => sum + (s.pedidosYaCommissionAmount || 0), 0) * 100) / 100;
    const appTax = Math.round(appSales.reduce((sum, s) => sum + (s.pedidosYaTaxAmount || 0), 0) * 100) / 100;
    const appNet = Math.round(appSales.reduce((sum, s) => sum + (s.pedidosYaNetPayout || 0), 0) * 100) / 100;

    const cashGross = Math.round(cashSales.reduce((sum, s) => sum + s.total, 0) * 100) / 100;
    const cashCommission = Math.round(cashSales.reduce((sum, s) => sum + (s.pedidosYaCommissionAmount || 0), 0) * 100) / 100;
    const cashTax = Math.round(cashSales.reduce((sum, s) => sum + (s.pedidosYaTaxAmount || 0), 0) * 100) / 100;
    const cashNet = Math.round(cashSales.reduce((sum, s) => sum + (s.pedidosYaNetPayout || 0), 0) * 100) / 100;

    const grossTotal = Math.round((appGross + cashGross) * 100) / 100;
    const commissionTotal = Math.round((appCommission + cashCommission) * 100) / 100;
    const taxTotal = Math.round((appTax + cashTax) * 100) / 100;

    // Cálculo clave: neto a recibir de PedidosYa = (ventas APP - comisión e impuesto de TODOS los pedidos)
    // Si da negativo, es lo que el negocio le debe a PedidosYa
    const netPayout = Math.round((appGross - commissionTotal - taxTotal) * 100) / 100;

    return {
      ordersCount: sales.length,
      grossTotal,
      commissionTotal,
      taxTotal,
      netPayout,
      appSales: {
        ordersCount: appSales.length,
        gross: appGross,
        commission: appCommission,
        tax: appTax,
        net: appNet,
      },
      cashSales: {
        ordersCount: cashSales.length,
        gross: cashGross,
        commission: cashCommission,
        tax: cashTax,
        net: cashNet,
      },
      orders: sales,
    };
  }

  async createSettlement(
    businessId: string,
    dto: CreatePedidosYaSettlementDto,
    userId?: string,
  ) {
    if (!dto.saleIds || dto.saleIds.length === 0) {
      throw new BadRequestException('Debe seleccionar al menos una venta para liquidar');
    }

    return this.prisma.$transaction(async (tx) => {
      const sales = await tx.sale.findMany({
        where: {
          id: { in: dto.saleIds },
          businessId,
          channel: 'PEDIDOSYA',
        },
      });

      if (sales.length !== dto.saleIds.length) {
        throw new BadRequestException('Una o más ventas seleccionadas no pertenecen a PedidosYa o no existen');
      }

      const alreadySettled = sales.filter(
        (s) => s.pedidosYaSettlementStatus === 'LIQUIDADO' || s.pedidosYaSettlementId != null,
      );
      if (alreadySettled.length > 0) {
        const numbers = alreadySettled.map((s) => s.invoiceNumber).join(', ');
        throw new BadRequestException(`Los siguientes pedidos ya estaban liquidados: ${numbers}`);
      }

      const appSales = sales.filter((s) => (s.pedidosYaPaymentMode || 'APP') === 'APP');
      const appGross = appSales.reduce((sum, s) => sum + s.total, 0);
      const allCommission = sales.reduce((sum, s) => sum + (s.pedidosYaCommissionAmount || 0), 0);
      const allTax = sales.reduce((sum, s) => sum + (s.pedidosYaTaxAmount || 0), 0);

      // Neto esperado según fórmula de PedidosYa
      const expectedAmount = Math.round((appGross - allCommission - allTax) * 100) / 100;
      const depositAmount = Math.round(Number(dto.depositAmount) * 100) / 100;
      const difference = Math.round((depositAmount - expectedAmount) * 100) / 100;

      let bankName: string | null = null;
      if (dto.bankId) {
        const bank = await tx.posBank.findFirst({
          where: { id: dto.bankId, businessId },
        });
        if (bank) {
          bankName = bank.name;
        }
      }

      const settlement = await tx.pedidosYaSettlement.create({
        data: {
          businessId,
          depositDate: new Date(dto.depositDate),
          depositAmount,
          expectedAmount,
          difference,
          bankId: dto.bankId || null,
          bankName,
          reference: dto.reference?.trim() || null,
          notes: dto.notes?.trim() || null,
          ordersCount: sales.length,
          createdById: userId || null,
        },
      });

      await tx.sale.updateMany({
        where: { id: { in: dto.saleIds } },
        data: {
          pedidosYaSettlementStatus: 'LIQUIDADO',
          pedidosYaSettlementId: settlement.id,
        },
      });

      this.logger.log(
        `[createSettlement] Liquidación PedidosYa creada id=${settlement.id} pedidos=${sales.length} esperado=${expectedAmount} depositado=${depositAmount} dif=${difference}`,
      );

      return {
        ...settlement,
        settledOrders: sales.map((s) => ({
          id: s.id,
          invoiceNumber: s.invoiceNumber,
          pedidosYaOrderNumber: s.pedidosYaOrderNumber,
          total: s.total,
          netPayout: s.pedidosYaNetPayout,
        })),
      };
    });
  }

  async getSettlementHistory(businessId: string) {
    const settlements = await this.prisma.pedidosYaSettlement.findMany({
      where: { businessId },
      include: {
        bank: { select: { id: true, name: true } },
        sales: {
          select: {
            id: true,
            invoiceNumber: true,
            pedidosYaOrderNumber: true,
            total: true,
            pedidosYaNetPayout: true,
          },
        },
      },
      orderBy: { depositDate: 'desc' },
    });

    return settlements;
  }
}
