import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { MovementType, PayableAccountStatus, PosPaymentMethod, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GetPayablesDto } from './dto/get-payables.dto';
import { CreatePayablePaymentDto } from './dto/create-payable-payment.dto';
import { VoidPayablePaymentDto } from './dto/void-payable-payment.dto';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  formatDateInTimezone,
  parseLocalDateToUtc,
} from '../../../common/utils/date.util';

@Injectable()
export class PayablesService {
  private readonly logger = new Logger(PayablesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private getManaguaDates() {
    const todayStr = formatDateInTimezone(new Date(), DEFAULT_BUSINESS_TIMEZONE);
    const todayStartUtc = parseLocalDateToUtc(todayStr, '00:00:00.000', DEFAULT_BUSINESS_TIMEZONE);
    const todayEndUtc = parseLocalDateToUtc(todayStr, '23:59:59.999', DEFAULT_BUSINESS_TIMEZONE);

    const [y, m, d] = todayStr.split('-').map(Number);
    const next7DaysStr = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().split('T')[0];
    const next7DaysEndUtc = parseLocalDateToUtc(next7DaysStr, '23:59:59.999', DEFAULT_BUSINESS_TIMEZONE);

    return { todayStartUtc, todayEndUtc, next7DaysEndUtc };
  }

  private calculateDueMetrics(account: { dueDate: Date; status: PayableAccountStatus }) {
    const { todayStartUtc } = this.getManaguaDates();
    const dueStr = formatDateInTimezone(account.dueDate, DEFAULT_BUSINESS_TIMEZONE);
    const dueStartUtc = parseLocalDateToUtc(dueStr, '00:00:00.000', DEFAULT_BUSINESS_TIMEZONE);

    const diffMs = dueStartUtc.getTime() - todayStartUtc.getTime();
    const daysToDue = Math.round(diffMs / (1000 * 60 * 60 * 24));
    const isOverdue =
      (account.status === PayableAccountStatus.PENDING || account.status === PayableAccountStatus.PARTIALLY_PAID) &&
      daysToDue < 0;

    return { daysToDue, isOverdue };
  }

  async findAll(businessId: string, query: GetPayablesDto) {
    const { todayStartUtc } = this.getManaguaDates();
    const where: Prisma.PayableAccountWhereInput = { businessId };

    if (query.status) {
      where.status = query.status;
    }

    if (query.supplierId) {
      where.supplierId = query.supplierId;
    }

    if (query.onlyOverdue) {
      where.status = { in: [PayableAccountStatus.PENDING, PayableAccountStatus.PARTIALLY_PAID] };
      where.dueDate = { lt: todayStartUtc };
    }

    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      where.OR = [
        { supplier: { name: { contains: term, mode: 'insensitive' } } },
        { supplier: { taxId: { contains: term, mode: 'insensitive' } } },
        { purchase: { invoiceNumber: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const [total, items] = await Promise.all([
      this.prisma.payableAccount.count({ where }),
      this.prisma.payableAccount.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
        include: {
          supplier: {
            select: { id: true, name: true, phone: true, taxId: true },
          },
          purchase: {
            select: { id: true, invoiceNumber: true, purchaseDate: true, status: true },
          },
        },
      }),
    ]);

    const formattedItems = items.map((acc) => {
      const { daysToDue, isOverdue } = this.calculateDueMetrics(acc);
      const originalAmount = Number(acc.originalAmount);
      const balance = Number(acc.balance);
      const paidAmount = Math.round((originalAmount - balance) * 100) / 100;

      return {
        id: acc.id,
        purchaseId: acc.purchaseId,
        supplier: acc.supplier,
        invoiceNumber: acc.purchase.invoiceNumber,
        purchaseDate: acc.purchase.purchaseDate,
        dueDate: acc.dueDate,
        originalAmount,
        paidAmount,
        balance,
        status: acc.status,
        isOverdue,
        daysToDue,
        notes: acc.notes,
        createdAt: acc.createdAt,
      };
    });

    return {
      items: formattedItems,
      total,
      page,
      pageSize,
    };
  }

  async getSummary(businessId: string) {
    const { todayStartUtc, next7DaysEndUtc } = this.getManaguaDates();

    const activeAccounts = await this.prisma.payableAccount.findMany({
      where: {
        businessId,
        status: { in: [PayableAccountStatus.PENDING, PayableAccountStatus.PARTIALLY_PAID] },
      },
      select: {
        balance: true,
        dueDate: true,
        supplierId: true,
      },
    });

    let totalPayable = 0;
    let totalOverdue = 0;
    let dueNext7Days = 0;
    const suppliersWithDebtSet = new Set<string>();

    for (const acc of activeAccounts) {
      const bal = Number(acc.balance);
      if (bal <= 0) continue;

      totalPayable += bal;
      suppliersWithDebtSet.add(acc.supplierId);

      const dueStr = formatDateInTimezone(acc.dueDate, DEFAULT_BUSINESS_TIMEZONE);
      const dueStartUtc = parseLocalDateToUtc(dueStr, '00:00:00.000', DEFAULT_BUSINESS_TIMEZONE);

      if (dueStartUtc < todayStartUtc) {
        totalOverdue += bal;
      } else if (dueStartUtc <= next7DaysEndUtc) {
        dueNext7Days += bal;
      }
    }

    return {
      totalPayable: Math.round(totalPayable * 100) / 100,
      totalOverdue: Math.round(totalOverdue * 100) / 100,
      dueNext7Days: Math.round(dueNext7Days * 100) / 100,
      suppliersWithDebt: suppliersWithDebtSet.size,
    };
  }

  async findOne(id: string, businessId: string) {
    const account = await this.prisma.payableAccount.findFirst({
      where: { id, businessId },
      include: {
        supplier: true,
        purchase: {
          include: {
            items: {
              include: {
                product: { select: { id: true, name: true, sku: true, unit: true } },
              },
            },
            createdBy: { select: { id: true, name: true, email: true } },
          },
        },
        payments: {
          orderBy: { paidAt: 'desc' },
          include: {
            paidByUser: { select: { id: true, name: true, email: true } },
            voidedBy: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    if (!account) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'PAYABLE_NOT_FOUND',
        message: 'Cuenta por pagar no encontrada.',
      });
    }

    const { daysToDue, isOverdue } = this.calculateDueMetrics(account);
    const originalAmount = Number(account.originalAmount);
    const balance = Number(account.balance);
    const paidAmount = Math.round((originalAmount - balance) * 100) / 100;

    return {
      id: account.id,
      purchaseId: account.purchaseId,
      supplier: account.supplier,
      purchase: {
        ...account.purchase,
        total: Number(account.purchase.total),
        items: account.purchase.items.map((i) => ({
          ...i,
          quantity: Number(i.quantity),
          unitCost: Number(i.unitCost),
          subtotal: Number(i.subtotal),
        })),
      },
      invoiceNumber: account.purchase.invoiceNumber,
      purchaseDate: account.purchase.purchaseDate,
      dueDate: account.dueDate,
      originalAmount,
      paidAmount,
      balance,
      status: account.status,
      isOverdue,
      daysToDue,
      notes: account.notes,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      payments: account.payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        paymentMethod: p.paymentMethod,
        paidAt: p.paidAt,
        notes: p.notes,
        paidBy: p.paidByUser,
        isVoided: p.isVoided,
        voidedAt: p.voidedAt,
        voidReason: p.voidReason,
        voidedBy: p.voidedBy,
        hasCashMovement: Boolean(p.cashMovementId),
        createdAt: p.createdAt,
      })),
    };
  }

  async registerPayment(
    payableAccountId: string,
    dto: CreatePayablePaymentDto,
    businessId: string,
    userId: string,
  ) {
    if (dto.amount <= 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_PAYMENT_AMOUNT',
        message: 'El monto del abono debe ser mayor a cero.',
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Row lock on payable account
      await tx.$queryRaw`SELECT id FROM pos_payable_accounts WHERE id = ${payableAccountId} FOR UPDATE`;

      const account = await tx.payableAccount.findFirst({
        where: { id: payableAccountId, businessId },
        include: {
          supplier: { select: { id: true, name: true } },
          purchase: { select: { id: true, invoiceNumber: true } },
        },
      });

      if (!account) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'PAYABLE_NOT_FOUND',
          message: 'Cuenta por pagar no encontrada.',
        });
      }

      if (account.status === PayableAccountStatus.PAID || account.status === PayableAccountStatus.CANCELLED) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'PAYABLE_NOT_ACTIVE',
          message: `La cuenta por pagar no admite abonos (estado: ${account.status}).`,
        });
      }

      const amountDec = new Prisma.Decimal(dto.amount);
      if (amountDec.gt(account.balance)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'PAYMENT_EXCEEDS_BALANCE',
          message: `El monto del abono (${amountDec.toFixed(2)}) supera el saldo pendiente (${account.balance.toFixed(2)}).`,
        });
      }

      let cashMovementId: string | null = null;
      if (dto.deductFromCurrentShift) {
        if (dto.paymentMethod && dto.paymentMethod !== PosPaymentMethod.EFECTIVO) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'CASH_DEDUCTION_REQUIRES_CASH_METHOD',
            message: 'El descuento de turno de caja solo aplica cuando el método de pago es EFECTIVO.',
          });
        }

        const openShift = await tx.cashRegister.findFirst({
          where: { businessId, cashierId: userId, status: 'OPEN' },
          orderBy: { openedAt: 'desc' },
        });

        if (!openShift) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'NO_OPEN_CASH_REGISTER',
            message: 'No hay un turno de caja abierto para el usuario actual para descontar el abono de la gaveta.',
          });
        }

        const movement = await tx.cashMovement.create({
          data: {
            businessId,
            cashRegisterId: openShift.id,
            userId,
            type: MovementType.SALIDA,
            amount: amountDec,
            concept: `Abono proveedor ${account.supplier.name} compra ${account.purchase.invoiceNumber || account.purchase.id}`,
            currency: 'NIO',
            exchangeRate: new Prisma.Decimal(1),
            amountBase: amountDec,
          },
        });
        cashMovementId = movement.id;
      }

      const payment = await tx.supplierPayment.create({
        data: {
          payableAccountId: account.id,
          amount: amountDec,
          paymentMethod: dto.paymentMethod || PosPaymentMethod.EFECTIVO,
          paidAt: new Date(),
          notes: dto.notes ? dto.notes.trim() : null,
          paidByUserId: userId,
          cashMovementId,
        },
        include: {
          paidByUser: { select: { id: true, name: true, email: true } },
        },
      });

      const newBalance = account.balance.minus(amountDec);
      const newStatus = newBalance.equals(0) ? PayableAccountStatus.PAID : PayableAccountStatus.PARTIALLY_PAID;

      const updatedAccount = await tx.payableAccount.update({
        where: { id: account.id },
        data: {
          balance: newBalance,
          status: newStatus,
        },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole: UserRole.ENCARGADO,
          action: 'PAGAR_PROVEEDOR',
          entityType: 'SupplierPayment',
          entityId: payment.id,
          after: {
            payableAccountId: account.id,
            amount: Number(amountDec),
            previousBalance: Number(account.balance),
            newBalance: Number(newBalance),
            status: newStatus,
            cashMovementId,
          },
        },
        tx as any,
      );

      return {
        payment: {
          id: payment.id,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          paidAt: payment.paidAt,
          notes: payment.notes,
          paidBy: payment.paidByUser,
          hasCashMovement: Boolean(cashMovementId),
          cashMovementId: payment.cashMovementId,
        },
        payableAccount: {
          id: updatedAccount.id,
          balance: Number(updatedAccount.balance),
          status: updatedAccount.status,
        },
      };
    });

    this.logger.log(
      `[registerPayment] Abono registrado: payableAccountId=${payableAccountId} monto=${dto.amount} nuevoSaldo=${result.payableAccount.balance}`,
    );
    return result;
  }

  async voidPayment(
    payableAccountId: string,
    paymentId: string,
    dto: VoidPayablePaymentDto,
    businessId: string,
    userId: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      // Row lock on payable account
      await tx.$queryRaw`SELECT id FROM pos_payable_accounts WHERE id = ${payableAccountId} FOR UPDATE`;

      const account = await tx.payableAccount.findFirst({
        where: { id: payableAccountId, businessId },
        include: {
          supplier: { select: { id: true, name: true } },
          purchase: { select: { id: true, invoiceNumber: true } },
        },
      });

      if (!account) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'PAYABLE_NOT_FOUND',
          message: 'Cuenta por pagar no encontrada.',
        });
      }

      const payment = await tx.supplierPayment.findFirst({
        where: { id: paymentId, payableAccountId: account.id },
        include: {
          cashMovement: {
            include: {
              cashRegister: { select: { id: true, status: true } },
            },
          },
        },
      });

      if (!payment) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'PAYMENT_NOT_FOUND',
          message: 'Abono no encontrado en esta cuenta por pagar.',
        });
      }

      if (payment.isVoided) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'PAYMENT_ALREADY_VOIDED',
          message: 'Este abono ya fue anulado previamente.',
        });
      }

      let voidReasonNote = dto.reason.trim();

      // Compensatory cash movement if shift is OPEN
      if (payment.cashMovement) {
        const shift = payment.cashMovement.cashRegister;
        if (shift && shift.status === 'OPEN') {
          await tx.cashMovement.create({
            data: {
              businessId,
              cashRegisterId: shift.id,
              userId,
              type: MovementType.ENTRADA,
              amount: payment.amount,
              concept: `Reversión por anulación de abono proveedor ${account.supplier.name}: ${dto.reason.trim()}`,
              currency: 'NIO',
              exchangeRate: new Prisma.Decimal(1),
              amountBase: payment.amount,
            },
          });
        } else {
          voidReasonNote += ' (Turno de caja original cerrado; no se alteró arqueo histórico)';
        }
      }

      const voidedPayment = await tx.supplierPayment.update({
        where: { id: payment.id },
        data: {
          isVoided: true,
          voidedAt: new Date(),
          voidedById: userId,
          voidReason: voidReasonNote,
        },
      });

      const newBalance = account.balance.plus(payment.amount);
      const newStatus = newBalance.equals(account.originalAmount)
        ? PayableAccountStatus.PENDING
        : PayableAccountStatus.PARTIALLY_PAID;

      const updatedAccount = await tx.payableAccount.update({
        where: { id: account.id },
        data: {
          balance: newBalance,
          status: newStatus,
        },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole: UserRole.ENCARGADO,
          action: 'PAGAR_PROVEEDOR',
          entityType: 'SupplierPayment',
          entityId: payment.id,
          reason: `Anulación de abono: ${voidReasonNote}`,
          after: {
            payableAccountId: account.id,
            restoredAmount: Number(payment.amount),
            newBalance: Number(newBalance),
            status: newStatus,
          },
        },
        tx as any,
      );

      return {
        paymentId: voidedPayment.id,
        isVoided: true,
        voidReason: voidedPayment.voidReason,
        payableAccount: {
          id: updatedAccount.id,
          balance: Number(updatedAccount.balance),
          status: updatedAccount.status,
        },
      };
    });

    this.logger.log(
      `[voidPayment] Abono anulado: paymentId=${paymentId} payableAccountId=${payableAccountId} saldoRestaurado=${result.payableAccount.balance}`,
    );
    return result;
  }
}
