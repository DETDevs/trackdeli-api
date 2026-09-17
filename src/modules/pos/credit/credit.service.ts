import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BusinessProductType, CreditAccountStatus, PosPaymentMethod } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TrackingGateway } from '../../tracking/tracking.gateway';
import { BusinessProductsService } from '../../business-products/business-products.service';
import { RegisterCreditPaymentDto } from './dto/register-payment.dto';

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
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

      if (account.status === CreditAccountStatus.PAID || account.balance <= 0) {
        throw new BadRequestException('Esta cuenta por cobrar ya se encuentra completamente liquidada');
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
      if (acc.status === CreditAccountStatus.PAID || acc.balance <= 0) {
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
        where: { status: { not: CreditAccountStatus.PAID } },
        include: {
          payments: true,
          business: { select: { id: true, name: true } },
        },
      });

      const now = new Date();

      for (const acc of openAccounts) {
        const totalPaid = acc.payments.reduce((sum, p) => sum + p.amount, 0);
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
}
