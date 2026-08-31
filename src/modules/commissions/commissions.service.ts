import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommissionStatus, StatementStatus } from '@prisma/client';

@Injectable()
export class CommissionsService {
  private readonly logger = new Logger(CommissionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra la comisión correspondiente cuando un pedido pasa a ENTREGADO.
   */
  async registerCommission(order: any): Promise<void> {
    const deliveryFee = Number(order.deliveryFee || 0);
    if (deliveryFee <= 0) {
      this.logger.debug(`[registerCommission] Pedido ${order.id} sin deliveryFee. Omitiendo.`);
      return;
    }

    // Verificar si ya existe una comisión registrada para este pedido
    const existing = await this.prisma.orderCommission.findUnique({
      where: { orderId: order.id },
    });
    if (existing) {
      this.logger.debug(`[registerCommission] Comisión ya registrada para orderId=${order.id}`);
      return;
    }

    const business = await this.prisma.business.findUnique({
      where: { id: order.businessId },
    });

    const distanceKm = Number(order.distanceKm || 0);
    const threshold = business?.altCommissionDistanceKm ?? 40;
    const rate =
      distanceKm > threshold
        ? (business?.altCommissionRate ?? 0.12)
        : (business?.commissionRate ?? 0.15);

    const commissionAmount = Math.round(deliveryFee * rate * 100) / 100;

    await this.prisma.orderCommission.create({
      data: {
        orderId: order.id,
        businessId: order.businessId,
        deliveryFee,
        distanceKm,
        commissionRate: rate,
        commissionAmount,
        status: CommissionStatus.PENDING,
      },
    });

    this.logger.log(
      `[registerCommission] OK orderId=${order.id} fee=${deliveryFee} rate=${rate * 100}% amount=${commissionAmount.toFixed(2)}`,
    );
  }

  /**
   * Obtiene la lista de comisiones de un negocio.
   */
  async getCommissions(businessId: string, month?: number, year?: number) {
    const where: any = { businessId };

    if (month && year) {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59, 999);
      where.createdAt = { gte: startDate, lte: endDate };
    }

    return this.prisma.orderCommission.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            customerName: true,
            destinationAddress: true,
            deliveredAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Resumen de comisiones del mes actual para el encargado.
   */
  async getSummary(businessId: string) {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    const startDate = new Date(currentYear, currentMonth - 1, 1);
    const endDate = new Date(currentYear, currentMonth, 0, 23, 59, 59, 999);

    const commissions = await this.prisma.orderCommission.findMany({
      where: {
        businessId,
        createdAt: { gte: startDate, lte: endDate },
      },
      include: {
        order: {
          select: {
            id: true,
            customerName: true,
            deliveredAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalDeliveries = commissions.length;
    const totalDeliveryFee = commissions.reduce((sum, c) => sum + c.deliveryFee, 0);
    const totalCommission = commissions.reduce((sum, c) => sum + c.commissionAmount, 0);

    return {
      currentMonth: {
        month: currentMonth,
        year: currentYear,
        totalDeliveries,
        totalDeliveryFee: Math.round(totalDeliveryFee * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        commissions,
      },
    };
  }

  /**
   * Historial de estados de cuenta mensuales del negocio.
   */
  async getStatements(businessId: string) {
    return this.prisma.monthlyStatement.findMany({
      where: { businessId },
      include: {
        commissions: {
          select: {
            id: true,
            orderId: true,
            deliveryFee: true,
            commissionAmount: true,
            createdAt: true,
          },
        },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }

  // ==========================================
  // OPERACIONES SUPERADMIN
  // ==========================================

  /**
   * Genera los estados de cuenta mensuales para todos los negocios de tipo EMPRESA_RIDERS
   * que tengan comisiones pendientes en el mes especificado.
   */
  async generateMonthlyStatements(month: number, year: number) {
    this.logger.log(`[generateMonthlyStatements] Generando estados de cuenta para ${month}/${year}`);

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    // Fecha límite de pago: 5 del mes siguiente
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const dueDate = new Date(nextYear, nextMonth - 1, 5, 23, 59, 59, 999);

    // Obtener todas las empresas con comisiones pendientes en este período
    const pendingCommissions = await this.prisma.orderCommission.findMany({
      where: {
        status: CommissionStatus.PENDING,
        createdAt: { gte: startDate, lte: endDate },
      },
    });

    const businessMap = new Map<string, typeof pendingCommissions>();
    for (const comm of pendingCommissions) {
      const list = businessMap.get(comm.businessId) || [];
      list.push(comm);
      businessMap.set(comm.businessId, list);
    }

    const createdStatements = [];

    for (const [businessId, comms] of businessMap.entries()) {
      const totalDeliveries = comms.length;
      const totalDeliveryFee = comms.reduce((sum, c) => sum + c.deliveryFee, 0);
      const totalCommission = comms.reduce((sum, c) => sum + c.commissionAmount, 0);

      const statement = await this.prisma.monthlyStatement.upsert({
        where: {
          businessId_month_year: { businessId, month, year },
        },
        create: {
          businessId,
          month,
          year,
          totalDeliveries,
          totalDeliveryFee: Math.round(totalDeliveryFee * 100) / 100,
          totalCommission: Math.round(totalCommission * 100) / 100,
          status: StatementStatus.PENDING,
          dueDate,
        },
        update: {
          totalDeliveries,
          totalDeliveryFee: Math.round(totalDeliveryFee * 100) / 100,
          totalCommission: Math.round(totalCommission * 100) / 100,
          dueDate,
        },
      });

      // Asociar comisiones al estado de cuenta
      const commIds = comms.map((c) => c.id);
      await this.prisma.orderCommission.updateMany({
        where: { id: { in: commIds } },
        data: {
          statementId: statement.id,
          status: CommissionStatus.INCLUDED,
        },
      });

      createdStatements.push(statement);
    }

    this.logger.log(`[generateMonthlyStatements] Se generaron ${createdStatements.length} estados de cuenta.`);
    return createdStatements;
  }

  /**
   * SuperAdmin registra el pago (total o parcial) de un estado de cuenta.
   */
  async payStatement(
    statementId: string,
    dto: { paidAmount?: number; notes?: string },
  ) {
    const statement = await this.prisma.monthlyStatement.findUnique({
      where: { id: statementId },
    });
    if (!statement) {
      throw new NotFoundException('Estado de cuenta no encontrado');
    }

    const currentPaid = (statement.paidAmount || 0) + (dto.paidAmount || statement.totalCommission);
    let newStatus: StatementStatus = StatementStatus.PENDING;

    if (currentPaid >= statement.totalCommission) {
      newStatus = StatementStatus.PAID;
    } else if (currentPaid > 0) {
      newStatus = StatementStatus.PARTIAL;
    }

    const updated = await this.prisma.monthlyStatement.update({
      where: { id: statementId },
      data: {
        paidAmount: Math.round(currentPaid * 100) / 100,
        paidAt: newStatus === StatementStatus.PAID ? new Date() : statement.paidAt,
        status: newStatus,
        notes: dto.notes || statement.notes,
      },
    });

    if (newStatus === StatementStatus.PAID) {
      await this.prisma.orderCommission.updateMany({
        where: { statementId },
        data: { status: CommissionStatus.PAID },
      });
    }

    this.logger.log(`[payStatement] Statement ${statementId} actualizado a ${newStatus}, monto pagado=${currentPaid}`);
    return updated;
  }

  /**
   * Lista empresas deudoras con estados de cuenta en OVERDUE o PARTIAL.
   */
  async getDebtors() {
    // Actualizar automáticamente a OVERDUE los estados PENDING o PARTIAL cuya fecha de vencimiento ya pasó
    const now = new Date();
    await this.prisma.monthlyStatement.updateMany({
      where: {
        status: { in: [StatementStatus.PENDING, StatementStatus.PARTIAL] },
        dueDate: { lt: now },
      },
      data: { status: StatementStatus.OVERDUE },
    });

    return this.prisma.monthlyStatement.findMany({
      where: {
        status: { in: [StatementStatus.OVERDUE, StatementStatus.PARTIAL] },
      },
      include: {
        business: {
          select: {
            id: true,
            name: true,
            whatsappNumber: true,
            whatsappDisplay: true,
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    });
  }

  /**
   * Listado global de comisiones para auditoría del SuperAdmin.
   */
  async getAllCommissions(month?: number, year?: number, businessId?: string) {
    const where: any = {};
    if (businessId) where.businessId = businessId;

    if (month && year) {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59, 999);
      where.createdAt = { gte: startDate, lte: endDate };
    }

    return this.prisma.orderCommission.findMany({
      where,
      include: {
        business: { select: { id: true, name: true } },
        order: { select: { id: true, customerName: true, deliveredAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
