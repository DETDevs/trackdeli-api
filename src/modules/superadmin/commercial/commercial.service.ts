import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../pos/audit/audit.service';
import { UploadService } from '../../upload/upload.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { UpsertCommercialAgreementDto } from './dto/upsert-commercial-agreement.dto';
import { CreateCommercialPaymentDto } from './dto/create-commercial-payment.dto';
import { VoidCommercialPaymentDto } from './dto/void-commercial-payment.dto';
import { CreateCommercialEquipmentDto } from './dto/create-commercial-equipment.dto';
import { UpdateCommercialEquipmentDto } from './dto/update-commercial-equipment.dto';
import {
  addMonthsManagua,
  calculateDaysUntilDue,
  calculateGraceEndsAt,
  calculateGraceEndsAtDays,
  getManaguaDateParts,
  parseManaguaDate,
  resolveBusinessCoverage,
  toManaguaDateString,
} from '../utils/membership-billing.util';
import { Prisma } from '@prisma/client';

const SERIAL_REQUIRED_EQUIPMENT_TYPES = [
  'COMPUTADORA',
  'MONITOR',
  'IMPRESORA_TERMICA',
  'GAVETA_DINERO',
  'LECTOR_BARRA',
  'IMPRESORA_COCINA',
  'TABLET',
];

@Injectable()
export class CommercialService {
  private readonly logger = new Logger(CommercialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly uploadService: UploadService,
  ) {}

  /**
   * Obtiene el acuerdo comercial de un negocio con sus cuotas, pagos, equipos y resumen calculado.
   */
  async getCommercialAgreement(businessId: string) {
    this.logger.log(`[getCommercialAgreement] Obteniendo acuerdo comercial para businessId=${businessId}`);

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        commercialAgreement: {
          include: {
            installments: {
              orderBy: { installmentNumber: 'asc' },
            },
            payments: {
              orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
            },
            equipment: {
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const agreement = business.commercialAgreement;
    if (!agreement) {
      return null;
    }

    const now = new Date();
    const coverage = await resolveBusinessCoverage(this.prisma, businessId, now);

    // 1. Pagos no anulados
    const validPayments = agreement.payments.filter((p) => p.voidedAt === null);
    const totalPaid = Math.round(
      validPayments.reduce((acc, p) => acc + Number(p.amount), 0) * 100,
    ) / 100;
    const balance = Math.max(
      0,
      Math.round((Number(agreement.totalPrice) - totalPaid) * 100) / 100,
    );

    // 2. Cuotas con estado calculado en tiempo de lectura
    const graceDays = agreement.graceDays !== null && agreement.graceDays !== undefined ? agreement.graceDays : 3;
    let overdueAmount = 0;
    let overdueInstallments = 0;
    let nextInstallment: any = null;

    const installments = agreement.installments.map((inst) => {
      const amt = Number(inst.amount);
      const paid = Number(inst.paidAmount);
      const dueDate = new Date(inst.dueDate);
      const graceEndsAt = calculateGraceEndsAtDays(dueDate, graceDays);

      let status: 'PENDIENTE' | 'PARCIAL' | 'PAGADA' | 'VENCIDA' = 'PENDIENTE';
      if (paid >= amt) {
        status = 'PAGADA';
      } else if (now >= graceEndsAt) {
        status = 'VENCIDA';
        overdueAmount += (amt - paid);
        overdueInstallments++;
      } else if (paid > 0) {
        status = 'PARCIAL';
      } else {
        status = 'PENDIENTE';
      }

      if (paid < amt && !nextInstallment) {
        nextInstallment = {
          id: inst.id,
          installmentNumber: inst.installmentNumber,
          dueDate: toManaguaDateString(dueDate),
          amount: amt,
          paidAmount: paid,
          pendingAmount: Math.round((amt - paid) * 100) / 100,
        };
      }

      return {
        id: inst.id,
        installmentNumber: inst.installmentNumber,
        dueDate: toManaguaDateString(dueDate),
        dueDateIso: dueDate.toISOString(),
        amount: amt,
        paidAmount: paid,
        pendingAmount: Math.round((amt - paid) * 100) / 100,
        status,
        paidAt: inst.paidAt ? inst.paidAt.toISOString() : null,
      };
    });

    overdueAmount = Math.round(overdueAmount * 100) / 100;

    // 3. Estado de mantenimiento
    let maintenanceStatus: 'INCLUIDO' | 'EN_COBRO' | 'NO_APLICA' = 'NO_APLICA';
    let maintDaysLeft: number | null = null;
    let maintEndsAtStr: string | null = null;

    if (agreement.maintenanceFreeMonths === 0 || !agreement.maintenanceFreeEndsAt) {
      maintenanceStatus = 'NO_APLICA';
    } else {
      const mEndsAt = new Date(agreement.maintenanceFreeEndsAt);
      maintEndsAtStr = toManaguaDateString(mEndsAt);
      const mGrace = calculateGraceEndsAt(mEndsAt);
      maintDaysLeft = calculateDaysUntilDue(mEndsAt, now);

      if (now < mGrace) {
        maintenanceStatus = 'INCLUIDO';
      } else {
        maintenanceStatus = 'EN_COBRO';
      }
    }

    return {
      agreement: {
        id: agreement.id,
        businessId: agreement.businessId,
        saleModality: agreement.saleModality,
        paymentType: agreement.paymentType,
        status: agreement.status,
        totalPrice: Number(agreement.totalPrice),
        currency: agreement.currency,
        downPayment: Number(agreement.downPayment),
        financedBalance: Number(agreement.financedBalance),
        installmentsCount: agreement.installmentsCount,
        firstInstallmentDate: agreement.firstInstallmentDate
          ? toManaguaDateString(new Date(agreement.firstInstallmentDate))
          : null,
        graceDays: agreement.graceDays,
        activatedAt: toManaguaDateString(new Date(agreement.activatedAt)),
        maintenanceFreeMonths: agreement.maintenanceFreeMonths,
        maintenanceFreeEndsAt: maintEndsAtStr,
        maintenanceFeeNio: Number(agreement.maintenanceFeeNio),
        installationDoneAt: agreement.installationDoneAt
          ? toManaguaDateString(new Date(agreement.installationDoneAt))
          : null,
        trainingDoneAt: agreement.trainingDoneAt
          ? toManaguaDateString(new Date(agreement.trainingDoneAt))
          : null,
        notes: agreement.notes,
        createdBy: agreement.createdBy,
        createdAt: agreement.createdAt.toISOString(),
        updatedAt: agreement.updatedAt.toISOString(),
      },
      installments,
      payments: agreement.payments.map((p) => ({
        id: p.id,
        agreementId: p.agreementId,
        kind: p.kind,
        amount: Number(p.amount),
        paymentMethod: p.paymentMethod,
        referenceNumber: p.referenceNumber,
        paymentProofUrl: p.paymentProofUrl,
        paidAt: toManaguaDateString(new Date(p.paidAt)),
        paidAtIso: p.paidAt.toISOString(),
        paidAmountNio: p.paidAmountNio != null ? Number(p.paidAmountNio) : null,
        exchangeRate: p.exchangeRate != null ? Number(p.exchangeRate) : null,
        notes: p.notes,
        registeredBy: p.registeredBy,
        voidedAt: p.voidedAt ? p.voidedAt.toISOString() : null,
        voidedBy: p.voidedBy,
        voidReason: p.voidReason,
        createdAt: p.createdAt.toISOString(),
      })),
      equipment: agreement.equipment.map((e) => ({
        id: e.id,
        agreementId: e.agreementId,
        businessId: e.businessId,
        equipmentType: e.equipmentType,
        description: e.description,
        brand: e.brand,
        model: e.model,
        serialNumber: e.serialNumber,
        price: e.price != null ? Number(e.price) : null,
        status: e.status,
        deliveredAt: e.deliveredAt ? toManaguaDateString(new Date(e.deliveredAt)) : null,
        warrantyEndsAt: e.warrantyEndsAt ? toManaguaDateString(new Date(e.warrantyEndsAt)) : null,
        notes: e.notes,
        createdAt: e.createdAt.toISOString(),
      })),
      summary: {
        totalPaid,
        balance,
        overdueAmount,
        overdueInstallments,
        nextInstallment,
        maintenance: {
          status: maintenanceStatus,
          endsAt: maintEndsAtStr,
          daysLeft: maintDaysLeft,
          feeNio: Number(agreement.maintenanceFeeNio),
        },
        coverage: {
          source: coverage.source,
          coveredUntil: coverage.coveredUntilStr,
          blocked: coverage.isCommercialBlocked,
        },
      },
    };
  }

  /**
   * Crea o actualiza el acuerdo comercial de un negocio.
   */
  async upsertCommercialAgreement(
    businessId: string,
    dto: UpsertCommercialAgreementDto,
    user: JwtPayload,
  ) {
    this.logger.log(`[upsertCommercialAgreement] businessId=${businessId}, modality=${dto.saleModality}`);

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        commercialAgreement: {
          include: {
            payments: { where: { voidedAt: null } },
            installments: true,
          },
        },
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const existing = business.commercialAgreement;

    if (!existing && (!dto.saleModality || dto.totalPrice === undefined)) {
      throw new BadRequestException('saleModality y totalPrice son obligatorios al crear el acuerdo comercial');
    }

    const saleModality = dto.saleModality || existing?.saleModality;
    const paymentType = dto.paymentType || existing?.paymentType || 'CONTADO';
    const totalPrice = dto.totalPrice !== undefined
      ? Math.round(Number(dto.totalPrice) * 100) / 100
      : Number(existing?.totalPrice);

    // Bloqueo de términos si ya hay pagos válidos registrados
    if (existing && existing.payments.length > 0) {
      const requestedPaymentType = paymentType;
      const requestedDownPayment = dto.downPayment !== undefined ? Number(dto.downPayment) : Number(existing.downPayment);
      const requestedInstallmentsCount = dto.installmentsCount !== undefined ? dto.installmentsCount : existing.installmentsCount;
      const requestedSaleModality = saleModality;
      const requestedTotalPrice = totalPrice;

      const termsChanged =
        existing.saleModality !== requestedSaleModality ||
        existing.paymentType !== requestedPaymentType ||
        Number(existing.totalPrice) !== requestedTotalPrice ||
        Number(existing.downPayment) !== requestedDownPayment ||
        existing.installmentsCount !== requestedInstallmentsCount;

      if (termsChanged) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'AGREEMENT_TERMS_LOCKED',
          message: 'No se pueden modificar los términos comerciales porque ya existen pagos registrados',
        });
      }
    }

    const isCredit = paymentType === 'CREDITO';
    
    // Adelanto por defecto: 50% si es crédito y no se especifica
    let downPayment = 0;
    if (isCredit) {
      if (dto.downPayment !== undefined) {
        downPayment = Math.round(Number(dto.downPayment) * 100) / 100;
      } else {
        downPayment = Math.round(totalPrice * 0.5 * 100) / 100;
      }
    }

    const financedBalance = isCredit
      ? Math.max(0, Math.round((totalPrice - downPayment) * 100) / 100)
      : 0;

    let installmentsCount = 0;
    if (isCredit) {
      installmentsCount = dto.installmentsCount !== undefined ? dto.installmentsCount : 1;
      if (installmentsCount < 1) installmentsCount = 1;
      if (installmentsCount > 4) installmentsCount = 4;
    }

    const actDate = dto.activatedAt
      ? (parseManaguaDate(dto.activatedAt) || new Date(dto.activatedAt))
      : (existing?.activatedAt || new Date());

    const maintMonths =
      dto.saleModality === 'MEMBRESIA_MENSUAL'
        ? 0
        : dto.maintenanceFreeMonths !== undefined
          ? dto.maintenanceFreeMonths
          : 12;

    const maintEndsAt = maintMonths > 0 ? addMonthsManagua(actDate, maintMonths) : null;

    let firstInstDate: Date | null = null;
    if (isCredit && financedBalance > 0) {
      firstInstDate = dto.firstInstallmentDate
        ? (parseManaguaDate(dto.firstInstallmentDate) || new Date(dto.firstInstallmentDate))
        : addMonthsManagua(actDate, 1);
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Fijar billingAnchorDay si es la primera vez y no lo tiene
      if (!business.billingAnchorDay) {
        const anchorDay = getManaguaDateParts(actDate).day;
        await tx.business.update({
          where: { id: businessId },
          data: { billingAnchorDay: anchorDay },
        });
      }

      let agreement: any;

      if (!existing) {
        // Crear acuerdo
        agreement = await tx.businessCommercialAgreement.create({
          data: {
            businessId,
            saleModality,
            paymentType,
            status: 'VIGENTE',
            totalPrice: new Prisma.Decimal(totalPrice),
            currency: dto.currency || 'USD',
            downPayment: new Prisma.Decimal(downPayment),
            financedBalance: new Prisma.Decimal(financedBalance),
            installmentsCount,
            firstInstallmentDate: firstInstDate,
            graceDays: dto.graceDays !== undefined ? dto.graceDays : 3,
            activatedAt: actDate,
            maintenanceFreeMonths: maintMonths,
            maintenanceFreeEndsAt: maintEndsAt,
            maintenanceFeeNio: new Prisma.Decimal(dto.maintenanceFeeNio !== undefined ? dto.maintenanceFeeNio : 550),
            installationDoneAt: dto.installationDoneAt
              ? (parseManaguaDate(dto.installationDoneAt) || new Date(dto.installationDoneAt))
              : null,
            trainingDoneAt: dto.trainingDoneAt
              ? (parseManaguaDate(dto.trainingDoneAt) || new Date(dto.trainingDoneAt))
              : null,
            notes: dto.notes,
            createdBy: user.sub,
          },
        });

        // Generar cuotas si es crédito
        if (isCredit && installmentsCount > 0 && financedBalance > 0 && firstInstDate) {
          await this.generateInstallments(
            tx,
            agreement.id,
            financedBalance,
            installmentsCount,
            firstInstDate,
          );
        }

        await this.auditService.record(
          {
            businessId,
            userId: user.sub,
            userRole: user.role,
            action: 'COMMERCIAL_AGREEMENT_CREATED',
            entityType: 'BusinessCommercialAgreement',
            entityId: agreement.id,
            before: null,
            after: {
              saleModality: dto.saleModality,
              paymentType: dto.paymentType || 'CONTADO',
              totalPrice,
              downPayment,
              financedBalance,
              installmentsCount,
            },
            reason: 'Creación de acuerdo comercial para negocio',
          },
          tx,
        );
      } else {
        // Actualizar acuerdo existente
        const beforeData = {
          saleModality: existing.saleModality,
          totalPrice: Number(existing.totalPrice),
          downPayment: Number(existing.downPayment),
          activatedAt: existing.activatedAt,
        };

        agreement = await tx.businessCommercialAgreement.update({
          where: { id: existing.id },
          data: {
            saleModality: dto.saleModality,
            paymentType: dto.paymentType || 'CONTADO',
            totalPrice: new Prisma.Decimal(totalPrice),
            currency: dto.currency || 'USD',
            downPayment: new Prisma.Decimal(downPayment),
            financedBalance: new Prisma.Decimal(financedBalance),
            installmentsCount,
            firstInstallmentDate: firstInstDate,
            graceDays: dto.graceDays !== undefined ? dto.graceDays : 3,
            activatedAt: actDate,
            maintenanceFreeMonths: maintMonths,
            maintenanceFreeEndsAt: maintEndsAt,
            maintenanceFeeNio: new Prisma.Decimal(dto.maintenanceFeeNio !== undefined ? dto.maintenanceFeeNio : 550),
            installationDoneAt: dto.installationDoneAt
              ? (parseManaguaDate(dto.installationDoneAt) || new Date(dto.installationDoneAt))
              : null,
            trainingDoneAt: dto.trainingDoneAt
              ? (parseManaguaDate(dto.trainingDoneAt) || new Date(dto.trainingDoneAt))
              : null,
            notes: dto.notes,
          },
        });

        // Si no hay pagos registrados, regenerar cuotas
        if (existing.payments.length === 0) {
          await tx.commercialInstallment.deleteMany({ where: { agreementId: existing.id } });
          if (isCredit && installmentsCount > 0 && financedBalance > 0 && firstInstDate) {
            await this.generateInstallments(
              tx,
              agreement.id,
              financedBalance,
              installmentsCount,
              firstInstDate,
            );
          }
        }

        await this.auditService.record(
          {
            businessId,
            userId: user.sub,
            userRole: user.role,
            action: 'COMMERCIAL_AGREEMENT_UPDATED',
            entityType: 'BusinessCommercialAgreement',
            entityId: agreement.id,
            before: beforeData,
            after: {
              saleModality: dto.saleModality,
              totalPrice,
              downPayment,
              activatedAt: actDate,
            },
            reason: 'Actualización de acuerdo comercial',
          },
          tx,
        );
      }

      return agreement;
    }).then(() => this.getCommercialAgreement(businessId));
  }

  /**
   * Genera cuotas con división entera al centavo, absorbiendo la diferencia en la última cuota.
   */
  private async generateInstallments(
    tx: Prisma.TransactionClient,
    agreementId: string,
    financedBalance: number,
    installmentsCount: number,
    firstDueDate: Date,
  ) {
    const totalCents = Math.round(financedBalance * 100);
    const baseCents = Math.floor(totalCents / installmentsCount);
    const remainderCents = totalCents - (baseCents * installmentsCount);

    const fParts = getManaguaDateParts(firstDueDate);
    const anchorDay = fParts.day;

    for (let k = 1; k <= installmentsCount; k++) {
      const instCents = (k === installmentsCount) ? (baseCents + remainderCents) : baseCents;
      const instDueDate = (k === 1) ? firstDueDate : addMonthsManagua(firstDueDate, k - 1, anchorDay);

      await tx.commercialInstallment.create({
        data: {
          agreementId,
          installmentNumber: k,
          dueDate: instDueDate,
          amount: new Prisma.Decimal(instCents / 100),
          paidAmount: new Prisma.Decimal(0),
        },
      });
    }
  }

  /**
   * Registra un pago comercial (ADELANTO, CUOTA, PAGO).
   */
  async recordPayment(
    agreementId: string,
    dto: CreateCommercialPaymentDto,
    user: JwtPayload,
  ) {
    this.logger.log(`[recordPayment] agreementId=${agreementId}, kind=${dto.kind}, amount=${dto.amount}`);

    const agreement = await this.prisma.businessCommercialAgreement.findFirst({
      where: { OR: [{ id: agreementId }, { businessId: agreementId }] },
      include: {
        payments: { where: { voidedAt: null } },
        installments: { orderBy: { installmentNumber: 'asc' } },
        business: true,
      },
    });

    if (!agreement) {
      throw new NotFoundException('Acuerdo comercial no encontrado');
    }

    const payAmount = Math.round(Number(dto.amount) * 100) / 100;
    if (payAmount <= 0) {
      throw new BadRequestException('El monto debe ser mayor a 0');
    }

    const totalPaid = Math.round(
      agreement.payments.reduce((acc, p) => acc + Number(p.amount), 0) * 100,
    ) / 100;
    const currentBalance = Math.max(
      0,
      Math.round((Number(agreement.totalPrice) - totalPaid) * 100) / 100,
    );

    // Validación: no pasarse del saldo pendiente
    if (payAmount > currentBalance) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'PAYMENT_EXCEEDS_BALANCE',
        message: `El monto del pago ($${payAmount.toFixed(2)}) supera el saldo pendiente ($${currentBalance.toFixed(2)})`,
      });
    }

    // Validación específica para ADELANTO
    if (dto.kind === 'ADELANTO') {
      const downPaid = Math.round(
        agreement.payments
          .filter((p) => p.kind === 'ADELANTO')
          .reduce((acc, p) => acc + Number(p.amount), 0) * 100,
      ) / 100;
      const maxDown = Number(agreement.downPayment);
      const remainingDown = Math.max(0, Math.round((maxDown - downPaid) * 100) / 100);

      if (payAmount > remainingDown) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'PAYMENT_EXCEEDS_BALANCE',
          message: `El monto del adelanto ($${payAmount.toFixed(2)}) supera el adelanto pendiente ($${remainingDown.toFixed(2)})`,
        });
      }
    }

    const paidDate = dto.paidAt
      ? (parseManaguaDate(dto.paidAt) || new Date(dto.paidAt))
      : new Date();

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.commercialPayment.create({
        data: {
          agreementId: agreement.id,
          kind: dto.kind,
          amount: new Prisma.Decimal(payAmount),
          paymentMethod: dto.paymentMethod || 'TRANSFERENCIA',
          referenceNumber: dto.referenceNumber,
          paymentProofUrl: dto.paymentProofUrl,
          paidAt: paidDate,
          paidAmountNio: dto.paidAmountNio != null ? new Prisma.Decimal(dto.paidAmountNio) : null,
          exchangeRate: dto.exchangeRate != null ? new Prisma.Decimal(dto.exchangeRate) : null,
          notes: dto.notes,
          registeredBy: user.sub,
        },
      });

      // Recalcular cuotas FIFO con los pagos válidos
      await this.recalculateInstallmentsInternal(tx, agreement.id);

      // Si el saldo llega a 0, marcar LIQUIDADO
      const newBalance = Math.round((currentBalance - payAmount) * 100) / 100;
      if (newBalance <= 0) {
        await tx.businessCommercialAgreement.update({
          where: { id: agreement.id },
          data: { status: 'LIQUIDADO' },
        });
      }

      await this.auditService.record(
        {
          businessId: agreement.businessId,
          userId: user.sub,
          userRole: user.role,
          action: 'COMMERCIAL_PAYMENT_REGISTERED',
          entityType: 'CommercialPayment',
          entityId: payment.id,
          before: { balance: currentBalance },
          after: { paymentId: payment.id, amount: payAmount, kind: dto.kind, newBalance },
          reason: `Pago comercial registrado: $${payAmount} (${dto.kind})`,
        },
        tx,
      );

      return payment;
    });
  }

  /**
   * Sube comprobante de pago comercial a R2 (sin compresión Sharp, aceptando PDF e imágenes).
   */
  async uploadPaymentProof(paymentId: string, file: Express.Multer.File) {
    this.logger.log(`[uploadPaymentProof] Subiendo comprobante para paymentId=${paymentId}`);

    const payment = await this.prisma.commercialPayment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Pago comercial no encontrado');
    }

    if (!file) {
      throw new BadRequestException('Archivo no proporcionado');
    }

    const url = await this.uploadService.uploadDocument(file, `commercial/${payment.agreementId}`);

    const updated = await this.prisma.commercialPayment.update({
      where: { id: paymentId },
      data: { paymentProofUrl: url },
    });

    return {
      url,
      payment: updated,
    };
  }

  /**
   * Anula un pago comercial y recalcula todas las cuotas en una sola transacción.
   */
  async voidPayment(paymentId: string, dto: VoidCommercialPaymentDto, user: JwtPayload) {
    this.logger.log(`[voidPayment] paymentId=${paymentId}, reason=${dto.reason}`);

    const payment = await this.prisma.commercialPayment.findUnique({
      where: { id: paymentId },
      include: {
        agreement: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Pago comercial no encontrado');
    }

    if (payment.voidedAt) {
      throw new BadRequestException('El pago ya fue anulado previamente');
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const updatedPayment = await tx.commercialPayment.update({
        where: { id: paymentId },
        data: {
          voidedAt: now,
          voidedBy: user.sub,
          voidReason: dto.reason,
        },
      });

      // Recalcular todas las cuotas
      await this.recalculateInstallmentsInternal(tx, payment.agreementId);

      // Si el contrato estaba LIQUIDADO y ahora tiene saldo, vuelve a VIGENTE
      const nonVoided = await tx.commercialPayment.findMany({
        where: { agreementId: payment.agreementId, voidedAt: null },
      });
      const totalPaid = Math.round(
        nonVoided.reduce((acc, p) => acc + Number(p.amount), 0) * 100,
      ) / 100;
      const balance = Math.round((Number(payment.agreement.totalPrice) - totalPaid) * 100) / 100;

      if (balance > 0 && payment.agreement.status === 'LIQUIDADO') {
        await tx.businessCommercialAgreement.update({
          where: { id: payment.agreementId },
          data: { status: 'VIGENTE' },
        });
      }

      await this.auditService.record(
        {
          businessId: payment.agreement.businessId,
          userId: user.sub,
          userRole: user.role,
          action: 'COMMERCIAL_PAYMENT_VOIDED',
          entityType: 'CommercialPayment',
          entityId: paymentId,
          before: { amount: Number(payment.amount), kind: payment.kind },
          after: { voidedAt: now, voidedBy: user.sub, voidReason: dto.reason, balance },
          reason: `Pago comercial anulado: ${dto.reason}`,
        },
        tx,
      );

      return {
        success: true,
        paymentId,
        voidedAt: now.toISOString(),
      };
    });
  }

  /**
   * Recalcula desde cero todas las cuotas aplicando pagos válidos FIFO.
   */
  private async recalculateInstallmentsInternal(
    tx: Prisma.TransactionClient,
    agreementId: string,
  ) {
    // 1. Resetear cuotas
    await tx.commercialInstallment.updateMany({
      where: { agreementId },
      data: {
        paidAmount: new Prisma.Decimal(0),
        paidAt: null,
      },
    });

    // 2. Obtener cuotas ordenadas
    const installments = await tx.commercialInstallment.findMany({
      where: { agreementId },
      orderBy: { installmentNumber: 'asc' },
    });

    if (installments.length === 0) return;

    // 3. Obtener pagos CUOTA y PAGO válidos ordenados por fecha
    const validPayments = await tx.commercialPayment.findMany({
      where: {
        agreementId,
        kind: { in: ['CUOTA', 'PAGO'] },
        voidedAt: null,
      },
      orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
    });

    const instStates = installments.map((inst) => ({
      id: inst.id,
      amountCents: Math.round(Number(inst.amount) * 100),
      paidCents: 0,
      paidAt: null as Date | null,
    }));

    for (const p of validPayments) {
      let payCents = Math.round(Number(p.amount) * 100);

      for (const inst of instStates) {
        if (payCents <= 0) break;
        const remaining = inst.amountCents - inst.paidCents;
        if (remaining > 0) {
          const applied = Math.min(payCents, remaining);
          inst.paidCents += applied;
          payCents -= applied;
          if (inst.paidCents >= inst.amountCents) {
            inst.paidAt = p.paidAt;
          }
        }
      }
    }

    // 4. Actualizar cuotas en BD
    for (const inst of instStates) {
      await tx.commercialInstallment.update({
        where: { id: inst.id },
        data: {
          paidAmount: new Prisma.Decimal(inst.paidCents / 100),
          paidAt: inst.paidAt,
        },
      });
    }
  }

  /**
   * Agrega un equipo entregado con validación de serie obligatorio y único entre negocios.
   */
  async createEquipment(
    agreementId: string,
    dto: CreateCommercialEquipmentDto,
    user: JwtPayload,
  ) {
    this.logger.log(`[createEquipment] agreementId=${agreementId}, type=${dto.equipmentType}`);

    const agreement = await this.prisma.businessCommercialAgreement.findFirst({
      where: { OR: [{ id: agreementId }, { businessId: agreementId }] },
      include: { business: true },
    });

    if (!agreement) {
      throw new NotFoundException('Acuerdo comercial no encontrado');
    }

    const status = dto.status || 'PENDIENTE';
    const serial = (dto.serialNumber || '').trim();

    // Validación de número de serie obligatorio al pasar o crearse en ENTREGADO
    if (status === 'ENTREGADO' && SERIAL_REQUIRED_EQUIPMENT_TYPES.includes(dto.equipmentType)) {
      if (!serial) {
        throw new BadRequestException(
          `El número de serie es obligatorio para equipos de tipo ${dto.equipmentType}`,
        );
      }
    }

    // Validación de serie duplicada en otro negocio (si está ENTREGADO o PENDIENTE)
    if (serial && status !== 'RETIRADO') {
      const duplicate = await this.prisma.commercialEquipment.findFirst({
        where: {
          serialNumber: { equals: serial, mode: 'insensitive' },
          status: 'ENTREGADO',
          businessId: { not: agreement.businessId },
        },
        include: { business: { select: { name: true } } },
      });

      if (duplicate) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'SERIAL_ALREADY_REGISTERED',
          message: `El número de serie ya está registrado y entregado al negocio: ${duplicate.business.name}`,
        });
      }
    }

    const delDate = dto.deliveredAt
      ? (parseManaguaDate(dto.deliveredAt) || new Date(dto.deliveredAt))
      : (status === 'ENTREGADO' ? new Date() : null);

    const warDate = dto.warrantyEndsAt
      ? (parseManaguaDate(dto.warrantyEndsAt) || new Date(dto.warrantyEndsAt))
      : null;

    const equipment = await this.prisma.commercialEquipment.create({
      data: {
        agreementId: agreement.id,
        businessId: agreement.businessId,
        equipmentType: dto.equipmentType,
        description: dto.description,
        brand: dto.brand,
        model: dto.model,
        serialNumber: serial,
        price: dto.price != null ? new Prisma.Decimal(dto.price) : null,
        status,
        deliveredAt: delDate,
        warrantyEndsAt: warDate,
        notes: dto.notes,
      },
    });

    await this.auditService.record({
      businessId: agreement.businessId,
      userId: user.sub,
      userRole: user.role,
      action: 'COMMERCIAL_EQUIPMENT_CREATED',
      entityType: 'CommercialEquipment',
      entityId: equipment.id,
      before: null,
      after: {
        equipmentType: dto.equipmentType,
        serialNumber: serial,
        brand: dto.brand,
        model: dto.model,
        status,
      },
      reason: `Equipo agregado: ${dto.brand} ${dto.model} (${dto.equipmentType})`,
    });

    return equipment;
  }

  /**
   * Actualiza un equipo comercial.
   */
  async updateEquipment(
    id: string,
    dto: UpdateCommercialEquipmentDto,
    user: JwtPayload,
  ) {
    this.logger.log(`[updateEquipment] id=${id}`);

    const equipment = await this.prisma.commercialEquipment.findUnique({
      where: { id },
      include: {
        agreement: { select: { businessId: true } },
      },
    });

    if (!equipment) {
      throw new NotFoundException('Equipo comercial no encontrado');
    }

    const nextType = dto.equipmentType || equipment.equipmentType;
    const nextStatus = dto.status || equipment.status;
    const nextSerial = dto.serialNumber !== undefined ? dto.serialNumber.trim() : equipment.serialNumber;

    // Validación de número de serie obligatorio si pasa a ENTREGADO
    if (nextStatus === 'ENTREGADO' && SERIAL_REQUIRED_EQUIPMENT_TYPES.includes(nextType)) {
      if (!nextSerial) {
        throw new BadRequestException(
          `El número de serie es obligatorio para equipos de tipo ${nextType}`,
        );
      }
    }

    // Validación de serie duplicada en otro negocio si está ENTREGADO
    if (nextSerial && nextStatus !== 'RETIRADO') {
      const duplicate = await this.prisma.commercialEquipment.findFirst({
        where: {
          id: { not: id },
          serialNumber: { equals: nextSerial, mode: 'insensitive' },
          status: 'ENTREGADO',
          businessId: { not: equipment.businessId },
        },
        include: { business: { select: { name: true } } },
      });

      if (duplicate) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'SERIAL_ALREADY_REGISTERED',
          message: `El número de serie ya está registrado y entregado al negocio: ${duplicate.business.name}`,
        });
      }
    }

    const delDate = dto.deliveredAt !== undefined
      ? (dto.deliveredAt ? (parseManaguaDate(dto.deliveredAt) || new Date(dto.deliveredAt)) : null)
      : equipment.deliveredAt;

    const warDate = dto.warrantyEndsAt !== undefined
      ? (dto.warrantyEndsAt ? (parseManaguaDate(dto.warrantyEndsAt) || new Date(dto.warrantyEndsAt)) : null)
      : equipment.warrantyEndsAt;

    const updated = await this.prisma.commercialEquipment.update({
      where: { id },
      data: {
        ...(dto.equipmentType && { equipmentType: dto.equipmentType }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.brand && { brand: dto.brand }),
        ...(dto.model && { model: dto.model }),
        ...(dto.serialNumber !== undefined && { serialNumber: nextSerial }),
        ...(dto.price !== undefined && { price: dto.price != null ? new Prisma.Decimal(dto.price) : null }),
        ...(dto.status && { status: dto.status }),
        deliveredAt: delDate,
        warrantyEndsAt: warDate,
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });

    await this.auditService.record({
      businessId: equipment.businessId,
      userId: user.sub,
      userRole: user.role,
      action: 'COMMERCIAL_EQUIPMENT_UPDATED',
      entityType: 'CommercialEquipment',
      entityId: id,
      before: {
        status: equipment.status,
        serialNumber: equipment.serialNumber,
      },
      after: {
        status: updated.status,
        serialNumber: updated.serialNumber,
      },
      reason: `Equipo actualizado id=${id}`,
    });

    return updated;
  }
}
