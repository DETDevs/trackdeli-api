import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BusinessProductType, CreditAccountStatus, PosPaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TrackingGateway } from '../../tracking/tracking.gateway';
import { BusinessProductsService } from '../../business-products/business-products.service';
import { AuditService } from '../audit/audit.service';
import { PosAction } from '../permissions/permissions.service';
import { RegisterCreditPaymentDto } from './dto/register-payment.dto';
import { CreateCreditGroupDto } from './dto/create-credit-group.dto';
import { UpdateCreditGroupDto } from './dto/update-credit-group.dto';
import { CreateCreditStatementDto } from './dto/create-statement.dto';
import { SettleCreditStatementDto } from './dto/settle-statement.dto';

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
    private readonly businessProductsService: BusinessProductsService,
    private readonly auditService: AuditService,
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

  async registerPayment(
    creditAccountId: string,
    dto: RegisterCreditPaymentDto,
    userId: string,
    businessId: string,
  ) {
    await this.ensureCarteraActive(businessId);
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.findFirst({
        where: { id: creditAccountId, businessId },
        include: { customer: true, sale: true },
      });

      if (!account) {
        throw new NotFoundException('Cuenta por cobrar no encontrada');
      }

      if (account.status === CreditAccountStatus.PAID || account.status === CreditAccountStatus.CANCELLED || account.balance <= 0) {
        throw new BadRequestException('Esta cuenta por cobrar ya se encuentra liquidada o cancelada');
      }

      const amountToDeduct = Math.round(dto.amount * 100) / 100;
      if (amountToDeduct <= 0) {
        throw new BadRequestException('El monto a abonar debe ser mayor a 0');
      }

      // Actualización atómica con validación de saldo para evitar race conditions
      const updatedCount = await tx.$executeRaw`
        UPDATE "pos_credit_accounts"
        SET "balance" = ROUND(("balance" - ${amountToDeduct})::numeric, 2),
            "updatedAt" = NOW()
        WHERE "id" = ${creditAccountId}
          AND "balance" >= ${amountToDeduct}
      `;

      if (updatedCount === 0) {
        throw new BadRequestException(
          `El abono (${amountToDeduct.toFixed(2)}) excede el saldo pendiente actual (${account.balance.toFixed(2)}) o la cuenta ya fue liquidada`,
        );
      }

      const payment = await tx.creditPayment.create({
        data: {
          creditAccountId,
          amount: amountToDeduct,
          paymentMethod: dto.paymentMethod,
          receivedByUserId: userId,
          notes: dto.notes ? dto.notes.trim() : null,
          receivedAt: new Date(),
        },
        include: {
          receivedByUser: { select: { id: true, name: true, email: true } },
        },
      });

      const refreshed = await tx.creditAccount.findUniqueOrThrow({
        where: { id: creditAccountId },
      });

      let newStatus: CreditAccountStatus;
      if (refreshed.balance <= 0.005) {
        newStatus = CreditAccountStatus.PAID;
      } else if (refreshed.balance < refreshed.originalAmount) {
        newStatus = CreditAccountStatus.PARTIALLY_PAID;
      } else {
        newStatus = refreshed.dueDate < new Date() ? CreditAccountStatus.OVERDUE : CreditAccountStatus.PENDING;
      }

      const finalAccount = await tx.creditAccount.update({
        where: { id: creditAccountId },
        data: { status: newStatus },
        include: {
          customer: true,
          sale: { select: { id: true, invoiceNumber: true, total: true, createdAt: true } },
          payments: {
            orderBy: { receivedAt: 'desc' },
            include: { receivedByUser: { select: { id: true, name: true } } },
          },
        },
      });

      this.trackingGateway.notifyBusiness(businessId, 'credit_payment_registered', {
        creditAccountId,
        paymentId: payment.id,
        amount: amountToDeduct,
        balance: finalAccount.balance,
        status: finalAccount.status,
        customerId: account.customerId,
        customerName: account.customer.name,
        invoiceNumber: account.sale.invoiceNumber,
      });

      this.logger.log(
        `[registerPayment] Abono registrado exitosamente: creditAccountId=${creditAccountId} monto=${amountToDeduct} nuevoSaldo=${finalAccount.balance} estado=${finalAccount.status}`,
      );

      return {
        payment,
        account: finalAccount,
      };
    });
  }

  async getCustomerCreditAccounts(customerId: string, businessId: string) {
    await this.ensureCarteraActive(businessId);
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });

    if (!customer) {
      throw new NotFoundException('Cliente no encontrado en este negocio');
    }

    const accounts = await this.prisma.creditAccount.findMany({
      where: { customerId, businessId },
      orderBy: { createdAt: 'desc' },
      include: {
        sale: { select: { id: true, invoiceNumber: true, total: true, createdAt: true } },
        payments: {
          orderBy: { receivedAt: 'desc' },
          include: { receivedByUser: { select: { id: true, name: true } } },
        },
      },
    });

    const now = new Date();
    let totalDebt = 0;
    let overdueDebt = 0;
    let activeAccountsCount = 0;
    let paidAccountsCount = 0;

    for (const acc of accounts) {
      if (acc.status === CreditAccountStatus.PAID || acc.status === CreditAccountStatus.CANCELLED || acc.balance <= 0) {
        paidAccountsCount++;
      } else {
        activeAccountsCount++;
        totalDebt += acc.balance;
        if (acc.status === CreditAccountStatus.OVERDUE || acc.dueDate < now) {
          overdueDebt += acc.balance;
        }
      }
    }

    totalDebt = Math.round(totalDebt * 100) / 100;
    overdueDebt = Math.round(overdueDebt * 100) / 100;
    const availableCredit =
      customer.creditLimit !== null && customer.creditLimit !== undefined
        ? Math.max(0, Math.round((customer.creditLimit - totalDebt) * 100) / 100)
        : null;

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        ruc: customer.ruc,
        creditLimit: customer.creditLimit,
      },
      summary: {
        totalDebt,
        overdueDebt,
        activeAccountsCount,
        paidAccountsCount,
        creditLimit: customer.creditLimit,
        availableCredit,
      },
      accounts,
    };
  }

  async getCreditAccount(id: string, businessId: string) {
    await this.ensureCarteraActive(businessId);
    const account = await this.prisma.creditAccount.findFirst({
      where: { id, businessId },
      include: {
        customer: true,
        sale: { select: { id: true, invoiceNumber: true, total: true, createdAt: true } },
        payments: {
          orderBy: { receivedAt: 'desc' },
          include: { receivedByUser: { select: { id: true, name: true } } },
        },
      },
    });

    if (!account) {
      throw new NotFoundException('Cuenta por cobrar no encontrada');
    }

    return account;
  }

  @Cron('0 */30 * * * *')
  async reconcileCreditAccounts(): Promise<void> {
    try {
      const openAccounts = await this.prisma.creditAccount.findMany({
        where: { status: { notIn: [CreditAccountStatus.PAID, CreditAccountStatus.CANCELLED] } },
        include: {
          payments: true,
          business: { select: { id: true, name: true } },
        },
      });

      const now = new Date();

      for (const acc of openAccounts) {
        const totalPaid = acc.payments.reduce((sum, p) => sum + Number(p.amount), 0);
        const expectedBalance = Math.round((acc.originalAmount - totalPaid) * 100) / 100;
        const currentBalance = Math.round(acc.balance * 100) / 100;

        // Detección de drift sin sobrescribir automáticamente
        if (Math.abs(expectedBalance - currentBalance) > 0.01) {
          this.logger.error(
            `[CreditReconciliation] ¡DRIFT DETECTADO! Cuenta ${acc.id} (Negocio: ${acc.business.name}). Saldo materializado=${currentBalance}, saldo calculado=${expectedBalance}. Diferencia=${(currentBalance - expectedBalance).toFixed(2)}. Requiere auditoría manual.`,
          );
        }

        // Transicionar automáticamente a OVERDUE si ya venció
        if (acc.status === CreditAccountStatus.PENDING && acc.dueDate < now) {
          await this.prisma.creditAccount.update({
            where: { id: acc.id },
            data: { status: CreditAccountStatus.OVERDUE },
          });
          this.logger.log(`[CreditReconciliation] Cuenta ${acc.id} transicionada a OVERDUE`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[CreditReconciliation] Error en reconciliación de cuentas de crédito: ${err.message}`);
    }
  }

  calculateNextCut(
    group: {
      id: string;
      billingCycle: string;
      cutDay1: number | null;
      cutDay2: number | null;
      payDayOffset: number | null;
    },
    lastStatement?: { periodTo: Date } | null,
  ) {
    const now = new Date();
    let fromDate: Date;

    if (lastStatement && lastStatement.periodTo) {
      fromDate = new Date(lastStatement.periodTo.getTime() + 24 * 60 * 60 * 1000);
      fromDate.setHours(0, 0, 0, 0);
    } else {
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    }

    const year = fromDate.getFullYear();
    const month = fromDate.getMonth();

    const getDaysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

    let toDate: Date;

    if (group.billingCycle === 'MONTHLY') {
      const targetDay = group.cutDay1 || 30;
      const daysInThisMonth = getDaysInMonth(year, month);
      const actualCutDayThisMonth = Math.min(targetDay, daysInThisMonth);
      const candidateThisMonth = new Date(year, month, actualCutDayThisMonth, 23, 59, 59, 999);

      if (fromDate.getTime() <= candidateThisMonth.getTime()) {
        toDate = candidateThisMonth;
      } else {
        const nextMonth = month + 1;
        const nextMonthYear = year + Math.floor(nextMonth / 12);
        const normNextMonth = nextMonth % 12;
        const daysInNextMonth = getDaysInMonth(nextMonthYear, normNextMonth);
        const actualCutDayNext = Math.min(targetDay, daysInNextMonth);
        toDate = new Date(nextMonthYear, normNextMonth, actualCutDayNext, 23, 59, 59, 999);
      }
    } else if (group.billingCycle === 'BIWEEKLY') {
      let day1 = group.cutDay1 || 15;
      let day2 = group.cutDay2 || 30;
      if (day1 > day2) {
        const temp = day1;
        day1 = day2;
        day2 = temp;
      }

      const daysInThisMonth = getDaysInMonth(year, month);
      const actualDay1 = Math.min(day1, daysInThisMonth);
      const actualDay2 = Math.min(day2, daysInThisMonth);

      const candidate1 = new Date(year, month, actualDay1, 23, 59, 59, 999);
      const candidate2 = new Date(year, month, actualDay2, 23, 59, 59, 999);

      if (fromDate.getTime() <= candidate1.getTime()) {
        toDate = candidate1;
      } else if (fromDate.getTime() <= candidate2.getTime()) {
        toDate = candidate2;
      } else {
        const nextMonth = month + 1;
        const nextMonthYear = year + Math.floor(nextMonth / 12);
        const normNextMonth = nextMonth % 12;
        const daysInNextMonth = getDaysInMonth(nextMonthYear, normNextMonth);
        const actualNextDay1 = Math.min(day1, daysInNextMonth);
        toDate = new Date(nextMonthYear, normNextMonth, actualNextDay1, 23, 59, 59, 999);
      }
    } else if (group.billingCycle === 'WEEKLY') {
      toDate = new Date(fromDate.getTime() + 6 * 24 * 60 * 60 * 1000);
      toDate.setHours(23, 59, 59, 999);
    } else {
      toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      if (toDate < fromDate) {
        toDate = new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
      }
    }

    let payDueDate: Date | null = null;
    const offset = group.payDayOffset ?? 0;
    if (offset > 0) {
      payDueDate = new Date(toDate.getTime() + offset * 24 * 60 * 60 * 1000);
      payDueDate.setHours(23, 59, 59, 999);
    }

    const formatDateStr = (d: Date) => d.toISOString().split('T')[0];

    return {
      from: formatDateStr(fromDate),
      to: formatDateStr(toDate),
      payDueDate: payDueDate ? formatDateStr(payDueDate) : null,
      payDayOffset: offset,
    };
  }

  async createGroup(businessId: string, dto: CreateCreditGroupDto, userId: string, userRole: string) {
    await this.ensureCarteraActive(businessId);
    const name = dto.name.trim();

    const existing = await this.prisma.creditGroup.findFirst({
      where: {
        businessId,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    if (existing) {
      throw new ConflictException(`Ya existe una empresa/convenio con el nombre "${name}"`);
    }

    const group = await this.prisma.creditGroup.create({
      data: {
        businessId,
        name,
        taxId: dto.taxId?.trim() || null,
        contactName: dto.contactName?.trim() || null,
        contactPhone: dto.contactPhone?.trim() || null,
        contactEmail: dto.contactEmail?.trim() || null,
        billingCycle: dto.billingCycle || 'BIWEEKLY',
        cutDay1: dto.cutDay1 !== undefined ? dto.cutDay1 : (dto.billingCycle === 'MONTHLY' ? 30 : 15),
        cutDay2: dto.cutDay2 !== undefined ? dto.cutDay2 : 30,
        payDayOffset: dto.payDayOffset !== undefined ? dto.payDayOffset : 0,
        creditLimit: dto.creditLimit !== undefined ? new Prisma.Decimal(dto.creditLimit) : null,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: PosAction.GROUP_MANAGE,
      entityType: 'CreditGroup',
      entityId: group.id,
      after: group,
      reason: `Creación de empresa/convenio: ${group.name}`,
    });

    return {
      ...group,
      creditLimit: group.creditLimit ? Number(group.creditLimit) : null,
      balance: 0,
      availableCredit: group.creditLimit ? Number(group.creditLimit) : null,
      nextCut: this.calculateNextCut(group, null),
    };
  }

  async findAllGroups(businessId: string, options: { isActive?: boolean; q?: string } = {}) {
    await this.ensureCarteraActive(businessId);
    const where: Prisma.CreditGroupWhereInput = {
      businessId,
      ...(options.isActive !== undefined && { isActive: options.isActive }),
      ...(options.q && {
        OR: [
          { name: { contains: options.q.trim(), mode: 'insensitive' } },
          { taxId: { contains: options.q.trim(), mode: 'insensitive' } },
          { contactName: { contains: options.q.trim(), mode: 'insensitive' } },
        ],
      }),
    };

    const groups = await this.prisma.creditGroup.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            customers: true,
            statements: true,
          },
        },
        statements: {
          orderBy: { periodTo: 'desc' },
          take: 1,
        },
      },
    });

    return Promise.all(
      groups.map(async (g) => {
        const debtAgg = await this.prisma.creditAccount.aggregate({
          where: {
            customer: { groupId: g.id },
            businessId,
            status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
          },
          _sum: { balance: true },
        });

        const balance = debtAgg._sum.balance ? Math.round(Number(debtAgg._sum.balance) * 100) / 100 : 0;
        const limitNum = g.creditLimit !== null && g.creditLimit !== undefined ? Number(g.creditLimit) : null;
        const availableCredit = limitNum !== null ? Math.max(0, Math.round((limitNum - balance) * 100) / 100) : null;
        const lastStatement = g.statements[0] || null;

        return {
          id: g.id,
          businessId: g.businessId,
          name: g.name,
          taxId: g.taxId,
          contactName: g.contactName,
          contactPhone: g.contactPhone,
          contactEmail: g.contactEmail,
          billingCycle: g.billingCycle,
          cutDay1: g.cutDay1,
          cutDay2: g.cutDay2,
          payDayOffset: g.payDayOffset,
          creditLimit: limitNum,
          balance,
          availableCredit,
          isActive: g.isActive,
          customerCount: g._count.customers,
          statementCount: g._count.statements,
          nextCut: this.calculateNextCut(g, lastStatement),
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
        };
      }),
    );
  }

  async findGroupById(businessId: string, id: string) {
    await this.ensureCarteraActive(businessId);
    const g = await this.prisma.creditGroup.findFirst({
      where: { id, businessId },
      include: {
        _count: {
          select: {
            customers: true,
            statements: true,
          },
        },
        statements: {
          orderBy: { periodTo: 'desc' },
          take: 1,
        },
      },
    });

    if (!g) {
      throw new NotFoundException('Empresa/convenio no encontrada');
    }

    const debtAgg = await this.prisma.creditAccount.aggregate({
      where: {
        customer: { groupId: g.id },
        businessId,
        status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
      },
      _sum: { balance: true },
    });

    const balance = debtAgg._sum.balance ? Math.round(Number(debtAgg._sum.balance) * 100) / 100 : 0;
    const limitNum = g.creditLimit !== null && g.creditLimit !== undefined ? Number(g.creditLimit) : null;
    const availableCredit = limitNum !== null ? Math.max(0, Math.round((limitNum - balance) * 100) / 100) : null;
    const lastStatement = g.statements[0] || null;

    return {
      id: g.id,
      businessId: g.businessId,
      name: g.name,
      taxId: g.taxId,
      contactName: g.contactName,
      contactPhone: g.contactPhone,
      contactEmail: g.contactEmail,
      billingCycle: g.billingCycle,
      cutDay1: g.cutDay1,
      cutDay2: g.cutDay2,
      payDayOffset: g.payDayOffset,
      creditLimit: limitNum,
      balance,
      availableCredit,
      isActive: g.isActive,
      customerCount: g._count.customers,
      statementCount: g._count.statements,
      nextCut: this.calculateNextCut(g, lastStatement),
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }

  async updateGroup(businessId: string, id: string, dto: UpdateCreditGroupDto, userId: string, userRole: string) {
    await this.ensureCarteraActive(businessId);
    const existing = await this.prisma.creditGroup.findFirst({
      where: { id, businessId },
    });
    if (!existing) {
      throw new NotFoundException('Empresa/convenio no encontrada');
    }

    if (dto.name && dto.name.trim() !== existing.name) {
      const conflict = await this.prisma.creditGroup.findFirst({
        where: {
          businessId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
          NOT: { id },
        },
      });
      if (conflict) {
        throw new ConflictException(`Ya existe otra empresa con el nombre "${dto.name.trim()}"`);
      }
    }

    const updated = await this.prisma.creditGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.taxId !== undefined && { taxId: dto.taxId?.trim() || null }),
        ...(dto.contactName !== undefined && { contactName: dto.contactName?.trim() || null }),
        ...(dto.contactPhone !== undefined && { contactPhone: dto.contactPhone?.trim() || null }),
        ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail?.trim() || null }),
        ...(dto.billingCycle !== undefined && { billingCycle: dto.billingCycle }),
        ...(dto.cutDay1 !== undefined && { cutDay1: dto.cutDay1 }),
        ...(dto.cutDay2 !== undefined && { cutDay2: dto.cutDay2 }),
        ...(dto.payDayOffset !== undefined && { payDayOffset: dto.payDayOffset }),
        ...(dto.creditLimit !== undefined && {
          creditLimit: dto.creditLimit !== null ? new Prisma.Decimal(dto.creditLimit) : null,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: PosAction.GROUP_MANAGE,
      entityType: 'CreditGroup',
      entityId: id,
      before: existing,
      after: updated,
      reason: 'Actualización de empresa/convenio',
    });

    return this.findGroupById(businessId, id);
  }

  async deleteGroup(businessId: string, id: string, userId: string, userRole: string) {
    await this.ensureCarteraActive(businessId);
    const existing = await this.prisma.creditGroup.findFirst({
      where: { id, businessId },
      include: { _count: { select: { customers: true, statements: true } } },
    });
    if (!existing) {
      throw new NotFoundException('Empresa/convenio no encontrada');
    }

    if (existing._count.customers > 0 || existing._count.statements > 0) {
      const updated = await this.prisma.creditGroup.update({
        where: { id },
        data: { isActive: false },
      });
      await this.auditService.record({
        businessId,
        userId,
        userRole,
        action: PosAction.GROUP_MANAGE,
        entityType: 'CreditGroup',
        entityId: id,
        before: existing,
        after: updated,
        reason: 'Desactivación de empresa/convenio con clientes o cortes asociados',
      });
      return { message: 'Empresa desactivada (posee registros asociados)', group: updated };
    }

    await this.prisma.creditGroup.delete({ where: { id } });
    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: PosAction.GROUP_MANAGE,
      entityType: 'CreditGroup',
      entityId: id,
      before: existing,
      reason: 'Eliminación definitiva de empresa/convenio',
    });
    return { message: 'Empresa eliminada exitosamente' };
  }

  async getNextCut(businessId: string, id: string) {
    await this.ensureCarteraActive(businessId);
    const group = await this.prisma.creditGroup.findFirst({
      where: { id, businessId },
      include: {
        statements: {
          orderBy: { periodTo: 'desc' },
          take: 1,
        },
      },
    });
    if (!group) throw new NotFoundException('Empresa no encontrada');
    const lastStatement = group.statements[0] || null;
    return this.calculateNextCut(group, lastStatement);
  }

  async getGroupStatementReport(
    businessId: string,
    groupId: string,
    fromStr: string,
    toStr: string,
    format: string = 'json',
    page: number = 1,
    limit: number = 100,
  ) {
    await this.ensureCarteraActive(businessId);
    const group = await this.prisma.creditGroup.findFirst({
      where: { id: groupId, businessId },
    });
    if (!group) {
      throw new NotFoundException('Empresa/convenio no encontrada');
    }

    if (!fromStr || !toStr) {
      throw new BadRequestException('Parámetros "from" y "to" son requeridos');
    }

    const fromDate = fromStr.includes('T') ? new Date(fromStr) : new Date(`${fromStr}T00:00:00.000Z`);
    const toDate = toStr.includes('T') ? new Date(toStr) : new Date(`${toStr}T23:59:59.999Z`);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('Formato de fecha inválido en "from" o "to"');
    }
    if (fromDate > toDate) {
      throw new BadRequestException('"from" no puede ser mayor que "to"');
    }

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const skip = (safePage - 1) * safeLimit;

    const totalCustomersCount = await this.prisma.customer.count({
      where: { businessId, groupId },
    });

    const customers = await this.prisma.customer.findMany({
      where: { businessId, groupId },
      orderBy: { name: 'asc' },
      skip: format === 'csv' ? undefined : skip,
      take: format === 'csv' ? undefined : safeLimit,
      include: {
        sales: {
          where: {
            businessId,
            status: { notIn: ['VOIDED', 'CANCELLED'] },
            paymentMethod: PosPaymentMethod.CREDITO,
            OR: [
              { occurredAt: { gte: fromDate, lte: toDate } },
              { occurredAt: null, createdAt: { gte: fromDate, lte: toDate } },
            ],
          },
          orderBy: { createdAt: 'asc' },
          include: {
            items: true,
            returns: {
              select: { refundAmount: true },
            },
          },
        },
        creditAccounts: {
          where: { businessId },
          include: {
            payments: {
              orderBy: { receivedAt: 'asc' },
            },
          },
        },
      },
    });

    let totalPreviousBalance = 0;
    let totalSales = 0;
    let totalPayments = 0;
    let totalCurrentBalance = 0;
    let totalSalesCount = 0;

    const customerReports = customers.map((cust) => {
      let custPrevBalance = 0;
      for (const acc of cust.creditAccounts) {
        if (acc.createdAt < fromDate) {
          const paymentsBeforeFrom = acc.payments
            .filter((p) => p.receivedAt < fromDate)
            .reduce((sum, p) => sum + Number(p.amount), 0);
          const remDebt = Math.max(0, acc.originalAmount - paymentsBeforeFrom);
          custPrevBalance += remDebt;
        }
      }
      custPrevBalance = Math.round(custPrevBalance * 100) / 100;

      const mappedSales = cust.sales.map((s) => {
        const originalAmount = Math.round(Number(s.total) * 100) / 100;
        const refundedAmount = Math.round(
          s.returns.reduce((sum, r) => sum + Number(r.refundAmount), 0) * 100,
        ) / 100;
        const netAmount = Math.max(0, Math.round((originalAmount - refundedAmount) * 100) / 100);

        const itemsSummary = s.items
          .map((it) => `${it.quantity}x ${it.productName || 'Producto'}`)
          .join(', ');

        return {
          id: s.id,
          invoiceNumber: s.invoiceNumber || s.id.substring(0, 8),
          date: s.occurredAt || s.createdAt,
          itemsSummary: itemsSummary || 'Consumo a crédito',
          originalAmount,
          refundedAmount,
          netAmount,
        };
      });

      const custSubtotalSales = Math.round(
        mappedSales.reduce((sum, s) => sum + s.netAmount, 0) * 100,
      ) / 100;

      const periodPayments: any[] = [];
      for (const acc of cust.creditAccounts) {
        for (const p of acc.payments) {
          if (p.receivedAt >= fromDate && p.receivedAt <= toDate) {
            periodPayments.push({
              id: p.id,
              creditAccountId: acc.id,
              amount: Math.round(Number(p.amount) * 100) / 100,
              paymentMethod: p.paymentMethod,
              receivedAt: p.receivedAt,
              notes: p.notes,
            });
          }
        }
      }

      const custSubtotalPayments = Math.round(
        periodPayments.reduce((sum, p) => sum + p.amount, 0) * 100,
      ) / 100;

      const custCurrentBalance = Math.round(
        (custPrevBalance + custSubtotalSales - custSubtotalPayments) * 100,
      ) / 100;

      totalPreviousBalance += custPrevBalance;
      totalSales += custSubtotalSales;
      totalPayments += custSubtotalPayments;
      totalCurrentBalance += custCurrentBalance;
      totalSalesCount += mappedSales.length;

      return {
        customer: {
          id: cust.id,
          name: cust.name,
          phone: cust.phone,
          externalCode: cust.externalCode ?? null,
          ruc: cust.ruc ?? null,
          creditLimit: cust.creditLimit !== null ? Number(cust.creditLimit) : null,
        },
        previousBalance: custPrevBalance,
        sales: mappedSales,
        subtotalSales: custSubtotalSales,
        payments: periodPayments,
        subtotalPayments: custSubtotalPayments,
        currentBalance: custCurrentBalance,
      };
    });

    totalPreviousBalance = Math.round(totalPreviousBalance * 100) / 100;
    totalSales = Math.round(totalSales * 100) / 100;
    totalPayments = Math.round(totalPayments * 100) / 100;
    totalCurrentBalance = Math.round(totalCurrentBalance * 100) / 100;

    if (format === 'csv') {
      const bom = '\uFEFF';
      const sep = ';';
      let csv = bom;

      csv += `REPORTE DE DEDUCCIÓN POR EMPRESA (CONVENIO)\r\n`;
      csv += `Empresa${sep}"${group.name.replace(/"/g, '""')}"${sep}RUC${sep}"${group.taxId || 'N/A'}"\r\n`;
      csv += `Período${sep}"${fromStr}"${sep}al${sep}"${toStr}"\r\n`;
      csv += `Generado${sep}"${new Date().toISOString()}"\r\n\r\n`;

      csv += `Código Empleado${sep}Empleado${sep}Factura/Ticket${sep}Fecha${sep}Detalle de Ítems${sep}Monto Venta${sep}Saldo Anterior${sep}Abonos Período${sep}Saldo a Deducir\r\n`;

      for (const cr of customerReports) {
        if (cr.sales.length === 0) {
          csv += `"${cr.customer.externalCode || ''}"${sep}"${cr.customer.name.replace(/"/g, '""')}"${sep}Sin consumos${sep}${sep}${sep}0.00${sep}${cr.previousBalance.toFixed(2)}${sep}${cr.subtotalPayments.toFixed(2)}${sep}${cr.currentBalance.toFixed(2)}\r\n`;
        } else {
          for (let i = 0; i < cr.sales.length; i++) {
            const s = cr.sales[i];
            const dateStr = new Date(s.date).toISOString().replace('T', ' ').substring(0, 19);
            const isFirst = i === 0;
            const isLast = i === cr.sales.length - 1;
            csv += `"${cr.customer.externalCode || ''}"${sep}"${cr.customer.name.replace(/"/g, '""')}"${sep}"${s.invoiceNumber}"${sep}"${dateStr}"${sep}"${s.itemsSummary.replace(/"/g, '""')}"${sep}${s.netAmount.toFixed(2)}${sep}${isFirst ? cr.previousBalance.toFixed(2) : ''}${sep}${isLast ? cr.subtotalPayments.toFixed(2) : ''}${sep}${isLast ? cr.currentBalance.toFixed(2) : ''}\r\n`;
          }
          if (cr.sales.length > 1) {
            csv += `"${cr.customer.externalCode || ''}"${sep}"${cr.customer.name.replace(/"/g, '""')} (SUBTOTAL)"${sep}${sep}${sep}${sep}${cr.subtotalSales.toFixed(2)}${sep}${cr.previousBalance.toFixed(2)}${sep}${cr.subtotalPayments.toFixed(2)}${sep}${cr.currentBalance.toFixed(2)}\r\n`;
          }
        }
      }

      csv += `\r\n`;
      csv += `TOTALES${sep}"TOTAL GENERAL EMPRESA"${sep}${sep}${sep}${sep}${totalSales.toFixed(2)}${sep}${totalPreviousBalance.toFixed(2)}${sep}${totalPayments.toFixed(2)}${sep}${totalCurrentBalance.toFixed(2)}\r\n`;

      return {
        isCsv: true,
        csvData: csv,
        filename: `deduccion_${group.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${fromStr}_${toStr}.csv`,
      };
    }

    return {
      group: {
        id: group.id,
        name: group.name,
        taxId: group.taxId,
        billingCycle: group.billingCycle,
        creditLimit: group.creditLimit ? Number(group.creditLimit) : null,
        payDayOffset: group.payDayOffset,
      },
      period: {
        from: fromStr,
        to: toStr,
      },
      pagination: {
        totalCustomers: totalCustomersCount,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(totalCustomersCount / safeLimit),
      },
      totals: {
        totalPreviousBalance,
        totalSales,
        totalPayments,
        totalCurrentBalance,
        customerCount: customers.length,
        salesCount: totalSalesCount,
      },
      customers: customerReports,
    };
  }

  async createStatement(
    businessId: string,
    groupId: string,
    dto: CreateCreditStatementDto,
    userId: string,
    userRole: string,
  ) {
    await this.ensureCarteraActive(businessId);
    const group = await this.prisma.creditGroup.findFirst({
      where: { id: groupId, businessId },
    });
    if (!group) throw new NotFoundException('Empresa no encontrada');

    const fromDate = dto.from.includes('T') ? new Date(dto.from) : new Date(`${dto.from}T00:00:00.000Z`);
    const toDate = dto.to.includes('T') ? new Date(dto.to) : new Date(`${dto.to}T23:59:59.999Z`);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestException('Fechas de período inválidas');
    }
    if (fromDate > toDate) {
      throw new BadRequestException('La fecha "from" no puede ser mayor a "to"');
    }

    return this.prisma.$transaction(async (tx) => {
      const eligibleSales = await tx.sale.findMany({
        where: {
          businessId,
          status: { notIn: ['VOIDED', 'CANCELLED'] },
          paymentMethod: PosPaymentMethod.CREDITO,
          customer: { groupId },
          OR: [
            { occurredAt: { gte: fromDate, lte: toDate } },
            { occurredAt: null, createdAt: { gte: fromDate, lte: toDate } },
          ],
          creditStatementItem: null,
        },
        include: {
          customer: { select: { id: true, name: true, externalCode: true } },
          creditAccount: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (eligibleSales.length === 0) {
        throw new BadRequestException('No se encontraron ventas a crédito sin cortar para este período');
      }

      const count = await tx.creditStatement.count({ where: { businessId } });
      const yearMonth = `${fromDate.getFullYear()}${String(fromDate.getMonth() + 1).padStart(2, '0')}`;
      const statementNumber = `CORTE-${yearMonth}-${String(count + 1).padStart(3, '0')}`;

      const totalAmount = eligibleSales.reduce((sum, s) => {
        const bal = s.creditAccount ? s.creditAccount.balance : Number(s.total);
        return sum + bal;
      }, 0);
      const totalAmountDecimal = new Prisma.Decimal(Math.round(totalAmount * 100) / 100);

      let payDueDate: Date | null = null;
      if (group.payDayOffset && group.payDayOffset > 0) {
        payDueDate = new Date(toDate.getTime() + group.payDayOffset * 24 * 60 * 60 * 1000);
      }

      const statement = await tx.creditStatement.create({
        data: {
          businessId,
          groupId,
          statementNumber,
          periodFrom: fromDate,
          periodTo: toDate,
          cutDate: new Date(),
          payDueDate,
          status: 'OPEN',
          totalAmount: totalAmountDecimal,
          settledAmount: new Prisma.Decimal(0),
          notes: dto.notes?.trim() || null,
          createdById: userId,
          items: {
            create: eligibleSales.map((s) => ({
              saleId: s.id,
              customerId: s.customerId!,
              amount: new Prisma.Decimal(s.creditAccount ? s.creditAccount.balance : Number(s.total)),
              settledAmount: new Prisma.Decimal(0),
            })),
          },
        },
        include: {
          group: { select: { id: true, name: true, taxId: true, billingCycle: true } },
          items: {
            include: {
              customer: { select: { id: true, name: true, externalCode: true } },
              sale: { select: { id: true, invoiceNumber: true, total: true, occurredAt: true } },
            },
          },
        },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole,
          action: PosAction.GROUP_STATEMENT,
          entityType: 'CreditStatement',
          entityId: statement.id,
          after: statement,
          reason: `Creación de corte ${statementNumber} para empresa ${group.name} con ${eligibleSales.length} ventas`,
        },
        tx,
      );

      return statement;
    });
  }

  async findStatementById(businessId: string, id: string) {
    await this.ensureCarteraActive(businessId);
    const statement = await this.prisma.creditStatement.findFirst({
      where: { id, businessId },
      include: {
        group: true,
        items: {
          include: {
            customer: { select: { id: true, name: true, phone: true, externalCode: true, ruc: true } },
            sale: {
              include: {
                items: true,
                payments: true,
                creditAccount: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!statement) {
      throw new NotFoundException('Corte no encontrado');
    }

    return statement;
  }

  async findStatementsByGroup(businessId: string, groupId: string) {
    await this.ensureCarteraActive(businessId);
    return this.prisma.creditStatement.findMany({
      where: { businessId, groupId },
      orderBy: { cutDate: 'desc' },
      include: {
        _count: { select: { items: true } },
      },
    });
  }

  async settleStatement(
    businessId: string,
    statementId: string,
    dto: SettleCreditStatementDto,
    userId: string,
    userRole: string,
  ) {
    await this.ensureCarteraActive(businessId);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM pos_credit_statements WHERE id = ${statementId} FOR UPDATE`;

      const statement = await tx.creditStatement.findFirst({
        where: { id: statementId, businessId },
        include: {
          group: true,
          items: {
            include: {
              sale: {
                include: { creditAccount: true },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!statement) {
        throw new NotFoundException('Corte no encontrado');
      }

      if (statement.status === 'SETTLED') {
        throw new BadRequestException('El corte ya se encuentra completamente liquidado');
      }
      if (statement.status === 'CANCELLED') {
        throw new BadRequestException('El corte se encuentra cancelado');
      }

      const totalAmount = Number(statement.totalAmount);
      const currentSettled = Number(statement.settledAmount);
      const pendingToSettle = Math.round((totalAmount - currentSettled) * 100) / 100;

      const requestedAmount = dto.amount !== undefined ? Math.round(dto.amount * 100) / 100 : pendingToSettle;
      if (requestedAmount <= 0) {
        throw new BadRequestException('El monto a liquidar debe ser mayor a 0');
      }
      if (requestedAmount > pendingToSettle + 0.005) {
        throw new BadRequestException(
          `El monto solicitado (${requestedAmount.toFixed(2)}) supera el saldo pendiente del corte (${pendingToSettle.toFixed(2)})`,
        );
      }

      let unallocated = requestedAmount;
      const appliedPayments: any[] = [];

      for (const item of statement.items) {
        if (unallocated <= 0) break;

        const creditAccount = item.sale?.creditAccount;
        if (!creditAccount || creditAccount.balance <= 0) continue;

        const currentAccBalance = creditAccount.balance;
        const toPayOnAccount = Math.min(unallocated, currentAccBalance);
        const toPayRounded = Math.round(toPayOnAccount * 100) / 100;

        if (toPayRounded <= 0) continue;

        const updatedCount = await tx.$executeRaw`
          UPDATE "pos_credit_accounts"
          SET "balance" = ROUND(("balance" - ${toPayRounded})::numeric, 2),
              "updatedAt" = NOW()
          WHERE "id" = ${creditAccount.id}
            AND "balance" >= ${toPayRounded}
        `;

        if (updatedCount === 0) {
          continue;
        }

        const payment = await tx.creditPayment.create({
          data: {
            creditAccountId: creditAccount.id,
            amount: new Prisma.Decimal(toPayRounded),
            paymentMethod: dto.method,
            receivedByUserId: userId,
            notes: `Liquidación corte ${statement.statementNumber || statement.id}${dto.reference ? ` [Ref: ${dto.reference}]` : ''}`,
            receivedAt: new Date(),
          },
        });

        const refreshedAccount = await tx.creditAccount.findUniqueOrThrow({
          where: { id: creditAccount.id },
        });

        let newAccStatus: CreditAccountStatus;
        if (refreshedAccount.balance <= 0.005) {
          newAccStatus = CreditAccountStatus.PAID;
        } else if (refreshedAccount.balance < refreshedAccount.originalAmount) {
          newAccStatus = CreditAccountStatus.PARTIALLY_PAID;
        } else {
          newAccStatus = refreshedAccount.dueDate < new Date() ? CreditAccountStatus.OVERDUE : CreditAccountStatus.PENDING;
        }

        await tx.creditAccount.update({
          where: { id: creditAccount.id },
          data: { status: newAccStatus },
        });

        const itemNewSettled = Math.round((Number(item.settledAmount) + toPayRounded) * 100) / 100;
        await tx.creditStatementItem.update({
          where: { id: item.id },
          data: { settledAmount: new Prisma.Decimal(itemNewSettled) },
        });

        unallocated = Math.round((unallocated - toPayRounded) * 100) / 100;

        appliedPayments.push({
          creditAccountId: creditAccount.id,
          customerId: item.customerId,
          saleId: item.saleId,
          amountPaid: toPayRounded,
          paymentId: payment.id,
          remainingAccountBalance: refreshedAccount.balance,
        });
      }

      const totalActuallySettled = Math.round((requestedAmount - unallocated) * 100) / 100;
      const newStatementSettledTotal = Math.round((currentSettled + totalActuallySettled) * 100) / 100;
      const isFullySettled = newStatementSettledTotal >= totalAmount - 0.005;
      const newStatementStatus = isFullySettled ? 'SETTLED' : 'PARTIALLY_SETTLED';

      const updatedStatement = await tx.creditStatement.update({
        where: { id: statementId },
        data: {
          settledAmount: new Prisma.Decimal(newStatementSettledTotal),
          status: newStatementStatus,
          settledById: userId,
          settledAt: new Date(),
        },
        include: {
          group: { select: { id: true, name: true, taxId: true } },
          items: {
            include: {
              customer: { select: { id: true, name: true, externalCode: true } },
              sale: { select: { id: true, invoiceNumber: true, total: true } },
            },
          },
        },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole,
          action: PosAction.GROUP_SETTLE,
          entityType: 'CreditStatement',
          entityId: statement.id,
          before: { status: statement.status, settledAmount: statement.settledAmount },
          after: { status: updatedStatement.status, settledAmount: updatedStatement.settledAmount },
          reason: `Liquidación corte ${statement.statementNumber}: monto=${totalActuallySettled}, método=${dto.method}, ref=${dto.reference || 'N/A'}, estado=${newStatementStatus}`,
        },
        tx,
      );

      return {
        statement: updatedStatement,
        settlement: {
          amountSettledInThisTx: totalActuallySettled,
          totalSettled: newStatementSettledTotal,
          remainingBalance: Math.max(0, Math.round((totalAmount - newStatementSettledTotal) * 100) / 100),
          status: newStatementStatus,
          paymentsAppliedCount: appliedPayments.length,
          appliedPayments,
        },
      };
    });
  }

  async cancelStatement(businessId: string, statementId: string, userId: string, userRole: string) {
    await this.ensureCarteraActive(businessId);
    return this.prisma.$transaction(async (tx) => {
      const statement = await tx.creditStatement.findFirst({
        where: { id: statementId, businessId },
      });
      if (!statement) throw new NotFoundException('Corte no encontrado');
      if (statement.status === 'SETTLED') {
        throw new BadRequestException('No se puede cancelar un corte ya liquidado');
      }

      if (Number(statement.settledAmount) > 0) {
        throw new BadRequestException('No se puede cancelar un corte con liquidación parcial. Revierta los abonos primero');
      }

      await tx.creditStatementItem.deleteMany({
        where: { statementId },
      });

      const updated = await tx.creditStatement.update({
        where: { id: statementId },
        data: { status: 'CANCELLED' },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole,
          action: PosAction.GROUP_STATEMENT,
          entityType: 'CreditStatement',
          entityId: statementId,
          reason: `Cancelación/reapertura de corte ${statement.statementNumber}`,
        },
        tx,
      );

      return { message: 'Corte cancelado y ventas liberadas exitosamente', statement: updated };
    });
  }
}
