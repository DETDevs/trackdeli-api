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
      status: { in: ['COMPLETED', 'PARTIALLY_RETURNED'] },
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
        status: true,
        pedidosYaOrderNumber: true,
        pedidosYaPaymentMode: true,
        pedidosYaCommissionPct: true,
        pedidosYaTaxPct: true,
        pedidosYaCommissionAmount: true,
        pedidosYaTaxAmount: true,
        pedidosYaNetPayout: true,
        pedidosYaSettlementStatus: true,
        pedidosYaSettlementId: true,
        returns: {
          select: {
            refundAmount: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    let appGross = 0;
    let appCommission = 0;
    let appTax = 0;
    let appNet = 0;
    let appCount = 0;

    let cashGross = 0;
    let cashCommission = 0;
    let cashTax = 0;
    let cashNet = 0;
    let cashCount = 0;

    const mappedOrders = sales.map((s) => {
      const refundSum = (s.returns || []).reduce((sum: number, r: any) => sum + Number(r.refundAmount || 0), 0);
      const effectiveTotal = Math.max(0, Number(s.total || 0) - refundSum);
      const commPct = s.pedidosYaCommissionPct != null ? Number(s.pedidosYaCommissionPct) : 27;
      const taxPct = s.pedidosYaTaxPct != null ? Number(s.pedidosYaTaxPct) : 7;
      const effectiveComm = Math.round(effectiveTotal * (commPct / 100) * 100) / 100;
      const effectiveTax = Math.round(effectiveTotal * (taxPct / 100) * 100) / 100;
      const pMode = s.pedidosYaPaymentMode === 'EFECTIVO' ? 'EFECTIVO' : 'APP';

      let orderNet = 0;
      if (pMode === 'APP') {
        orderNet = Math.round((effectiveTotal - effectiveComm - effectiveTax) * 100) / 100;
        appGross += effectiveTotal;
        appCommission += effectiveComm;
        appTax += effectiveTax;
        appNet += orderNet;
        appCount++;
      } else {
        orderNet = Math.round((-effectiveComm - effectiveTax) * 100) / 100;
        cashGross += effectiveTotal;
        cashCommission += effectiveComm;
        cashTax += effectiveTax;
        cashNet += orderNet;
        cashCount++;
      }

      return {
        id: s.id,
        invoiceNumber: s.invoiceNumber,
        date: s.invoiceDate || s.createdAt,
        total: effectiveTotal,
        originalTotal: Number(s.total || 0),
        refundedAmount: refundSum,
        status: s.status,
        pedidosYaOrderNumber: s.pedidosYaOrderNumber,
        pedidosYaPaymentMode: pMode,
        commissionPct: commPct,
        taxPct,
        commissionAmount: effectiveComm,
        taxAmount: effectiveTax,
        netPayout: orderNet,
        settlementStatus: s.pedidosYaSettlementStatus || 'PENDIENTE',
        settlementId: s.pedidosYaSettlementId,
      };
    });

    appGross = Math.round(appGross * 100) / 100;
    appCommission = Math.round(appCommission * 100) / 100;
    appTax = Math.round(appTax * 100) / 100;
    appNet = Math.round(appNet * 100) / 100;

    cashGross = Math.round(cashGross * 100) / 100;
    cashCommission = Math.round(cashCommission * 100) / 100;
    cashTax = Math.round(cashTax * 100) / 100;
    cashNet = Math.round(cashNet * 100) / 100;

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
        ordersCount: appCount,
        gross: appGross,
        commission: appCommission,
        tax: appTax,
        net: appNet,
      },
      cashSales: {
        ordersCount: cashCount,
        gross: cashGross,
        commission: cashCommission,
        tax: cashTax,
        net: cashNet,
      },
      orders: mappedOrders,
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
        include: {
          returns: {
            select: { refundAmount: true },
          },
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

      let appGross = 0;
      let allCommission = 0;
      let allTax = 0;

      for (const s of sales) {
        const refundSum = (s.returns || []).reduce((sum: number, r: any) => sum + Number(r.refundAmount || 0), 0);
        const effectiveTotal = Math.max(0, Number(s.total || 0) - refundSum);
        const commPct = s.pedidosYaCommissionPct != null ? Number(s.pedidosYaCommissionPct) : 27;
        const taxPct = s.pedidosYaTaxPct != null ? Number(s.pedidosYaTaxPct) : 7;
        const effectiveComm = Math.round(effectiveTotal * (commPct / 100) * 100) / 100;
        const effectiveTax = Math.round(effectiveTotal * (taxPct / 100) * 100) / 100;
        const pMode = s.pedidosYaPaymentMode === 'EFECTIVO' ? 'EFECTIVO' : 'APP';

        allCommission += effectiveComm;
        allTax += effectiveTax;
        if (pMode === 'APP') {
          appGross += effectiveTotal;
        }
      }

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
