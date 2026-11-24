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
import {
  SaleModalityInput,
  UpsertCommercialAgreementDto,
} from './dto/upsert-commercial-agreement.dto';
import {
  CommercialPaymentKindInput,
  CreateCommercialPaymentDto,
} from './dto/create-commercial-payment.dto';
import { VoidCommercialPaymentDto } from './dto/void-commercial-payment.dto';
import { CreateCommercialEquipmentDto } from './dto/create-commercial-equipment.dto';
import { UpdateCommercialEquipmentDto } from './dto/update-commercial-equipment.dto';
import { UpdateCommercialPricingConfigDto } from './dto/update-commercial-pricing-config.dto';
import {
  addMonthsManagua,
  calculateDaysUntilDue,
  calculateDueDate,
  calculateGraceEndsAt,
  calculateGraceEndsAtDays,
  createManaguaDate,
  getManaguaDateParts,
  parseManaguaDate,
  resolveBusinessCoverage,
  toManaguaDateString,
} from '../utils/membership-billing.util';
import {
  BusinessProductStatus,
  CommercialEquipmentType,
  CommercialPaymentKind,
  CommercialSaleModality,
  MembershipStatus,
  MembershipType,
  PaymentMethod,
  Prisma,
} from '@prisma/client';

export const COMMERCIAL_PRICING_SETTING_KEY = 'commercial_pricing_config';

export interface CommercialPricingConfig {
  soloSistemaPriceUsd: number;
  comboCompletoPriceUsd: number;
  maintenanceMonthlyNio: number;
  maintenanceFreeMonths: number;
  defaultCreditDownPaymentPct: number;
  maxCreditInstallments: number;
  defaultGraceDays: number;
}

export const DEFAULT_COMMERCIAL_PRICING_CONFIG: CommercialPricingConfig = {
  soloSistemaPriceUsd: 380,
  comboCompletoPriceUsd: 800,
  maintenanceMonthlyNio: 555,
  maintenanceFreeMonths: 12,
  defaultCreditDownPaymentPct: 50,
  maxCreditInstallments: 4,
  defaultGraceDays: 3,
};

const SERIAL_REQUIRED_EQUIPMENT_TYPES = [
  'COMPUTADORA',
  'MONITOR',
  'IMPRESORA_TERMICA',
  'GAVETA_DINERO',
  'LECTOR_BARRA',
  'IMPRESORA_COCINA',
  'TABLET',
];

export function normalizeSaleModality(
  input?: SaleModalityInput | CommercialSaleModality | string | null,
): CommercialSaleModality {
  if (!input || input === 'MEMBRESIA' || input === 'MEMBRESIA_MENSUAL') {
    return CommercialSaleModality.MEMBRESIA_MENSUAL;
  }
  if (input === 'SOLO_SISTEMA' || input === 'PAGO_UNICO_SISTEMA') {
    return CommercialSaleModality.PAGO_UNICO_SISTEMA;
  }
  if (input === 'COMBO_COMPLETO') {
    return CommercialSaleModality.COMBO_COMPLETO;
  }
  if (input === 'COMBO_PARCIAL') {
    return CommercialSaleModality.COMBO_PARCIAL;
  }
  throw new BadRequestException(`Forma de venta inválida: ${input}`);
}

export function toPublicSaleModality(
  modality?: CommercialSaleModality | string | null,
): 'MEMBRESIA' | 'SOLO_SISTEMA' | 'COMBO_COMPLETO' | 'COMBO_PARCIAL' {
  if (!modality || modality === 'MEMBRESIA_MENSUAL' || modality === 'MEMBRESIA') {
    return 'MEMBRESIA';
  }
  if (modality === 'PAGO_UNICO_SISTEMA' || modality === 'SOLO_SISTEMA') {
    return 'SOLO_SISTEMA';
  }
  if (modality === 'COMBO_COMPLETO') {
    return 'COMBO_COMPLETO';
  }
  return 'COMBO_PARCIAL';
}

export function normalizeCommercialPaymentKind(
  kind: CommercialPaymentKindInput | CommercialPaymentKind | string,
): 'ADELANTO' | 'CUOTA' | 'PAGO' | 'MANTENIMIENTO' {
  if (kind === 'PRIMA' || kind === 'ADELANTO') return 'ADELANTO';
  if (kind === 'CUOTA') return 'CUOTA';
  if (kind === 'PAGO') return 'PAGO';
  if (kind === 'MANTENIMIENTO') return 'MANTENIMIENTO';
  throw new BadRequestException(`Tipo de pago inválido: ${kind}`);
}

@Injectable()
export class CommercialService {
  private readonly logger = new Logger(CommercialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly uploadService: UploadService,
  ) {}

  /**
   * 302a - Obtiene la configuración centralizada de precios de referencia comerciales.
   */
  async getPricingConfig(
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<CommercialPricingConfig> {
    const setting = await (db as any).platformSetting.findUnique({
      where: { key: COMMERCIAL_PRICING_SETTING_KEY },
    });

    if (!setting?.value) {
      return { ...DEFAULT_COMMERCIAL_PRICING_CONFIG };
    }

    try {
      const parsed = JSON.parse(setting.value);
      return {
        soloSistemaPriceUsd:
          parsed.soloSistemaPriceUsd !== undefined
            ? Number(parsed.soloSistemaPriceUsd)
            : DEFAULT_COMMERCIAL_PRICING_CONFIG.soloSistemaPriceUsd,
        comboCompletoPriceUsd:
          parsed.comboCompletoPriceUsd !== undefined
            ? Number(parsed.comboCompletoPriceUsd)
            : DEFAULT_COMMERCIAL_PRICING_CONFIG.comboCompletoPriceUsd,
        maintenanceMonthlyNio:
          parsed.maintenanceMonthlyNio !== undefined
            ? Number(parsed.maintenanceMonthlyNio)
            : DEFAULT_COMMERCIAL_PRICING_CONFIG.maintenanceMonthlyNio,
        maintenanceFreeMonths:
          parsed.maintenanceFreeMonths !== undefined
            ? Number(parsed.maintenanceFreeMonths)
            : DEFAULT_COMMERCIAL_PRICING_CONFIG.maintenanceFreeMonths,
        defaultCreditDownPaymentPct:
          parsed.defaultCreditDownPaymentPct !== undefined
            ? Number(parsed.defaultCreditDownPaymentPct)
            : DEFAULT_COMMERCIAL_PRICING_CONFIG.defaultCreditDownPaymentPct,
        maxCreditInstallments:
          parsed.maxCreditInstallments !== undefined
            ? Number(parsed.maxCreditInstallments)
            : DEFAULT_COMMERCIAL_PRICING_CONFIG.maxCreditInstallments,
        defaultGraceDays:
          parsed.defaultGraceDays !== undefined
            ? Number(parsed.defaultGraceDays)
            : DEFAULT_COMMERCIAL_PRICING_CONFIG.defaultGraceDays,
      };
    } catch {
      return { ...DEFAULT_COMMERCIAL_PRICING_CONFIG };
    }
  }

  /**
   * 302a - Actualiza la configuración centralizada de precios de referencia (solo Superadmin).
   */
  async updatePricingConfig(
    dto: UpdateCommercialPricingConfigDto,
    user: JwtPayload,
  ): Promise<CommercialPricingConfig> {
    const current = await this.getPricingConfig();
    const next: CommercialPricingConfig = {
      soloSistemaPriceUsd:
        dto.soloSistemaPriceUsd !== undefined
          ? Math.round(Number(dto.soloSistemaPriceUsd) * 100) / 100
          : current.soloSistemaPriceUsd,
      comboCompletoPriceUsd:
        dto.comboCompletoPriceUsd !== undefined
          ? Math.round(Number(dto.comboCompletoPriceUsd) * 100) / 100
          : current.comboCompletoPriceUsd,
      maintenanceMonthlyNio:
        dto.maintenanceMonthlyNio !== undefined
          ? Math.round(Number(dto.maintenanceMonthlyNio) * 100) / 100
          : current.maintenanceMonthlyNio,
      maintenanceFreeMonths:
        dto.maintenanceFreeMonths !== undefined
          ? dto.maintenanceFreeMonths
          : current.maintenanceFreeMonths,
      defaultCreditDownPaymentPct:
        dto.defaultCreditDownPaymentPct !== undefined
          ? Number(dto.defaultCreditDownPaymentPct)
          : current.defaultCreditDownPaymentPct,
      maxCreditInstallments:
        dto.maxCreditInstallments !== undefined
          ? dto.maxCreditInstallments
          : current.maxCreditInstallments,
      defaultGraceDays:
        dto.defaultGraceDays !== undefined
          ? dto.defaultGraceDays
          : current.defaultGraceDays,
    };

    await this.prisma.platformSetting.upsert({
      where: { key: COMMERCIAL_PRICING_SETTING_KEY },
      update: {
        value: JSON.stringify(next),
        updatedByUserId: user.sub,
      },
      create: {
        key: COMMERCIAL_PRICING_SETTING_KEY,
        value: JSON.stringify(next),
        description: 'Precios de referencia comerciales y mantenimiento mensual (302a)',
        updatedByUserId: user.sub,
      },
    });

    return next;
  }

  /**
   * Obtiene el acuerdo comercial de un negocio con sus cuotas, pagos, equipos y resumen calculado.
   * Mantiene compatibilidad total con 244a y agrega los campos de 302a.
   */
  async getCommercialAgreement(businessId: string, now: Date = new Date()) {
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
        memberships: {
          where: { status: { not: MembershipStatus.CANCELLED } },
          orderBy: [{ endDate: 'desc' }, { startDate: 'desc' }],
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

    const coverage = await resolveBusinessCoverage(this.prisma, businessId, now);

    // 1. Pagos no anulados
    const validPayments = agreement.payments.filter((p) => p.voidedAt === null);
    const totalPaid =
      Math.round(validPayments.reduce((acc, p) => acc + Number(p.amount), 0) * 100) / 100;
    const balance = Math.max(
      0,
      Math.round((Number(agreement.totalPrice) - totalPaid) * 100) / 100,
    );

    // 2. Cuotas con estado calculado en tiempo de lectura
    const graceDays =
      agreement.graceDays !== null && agreement.graceDays !== undefined
        ? agreement.graceDays
        : 3;
    let overdueAmount = 0;
    let overdueInstallments = 0;
    let nextInstallment: any = null;

    const installments = agreement.installments.map((inst) => {
      const amt = Number(inst.amount);
      const paid = Number(inst.paidAmount);
      const dueDate = new Date(inst.dueDate);
      const graceEndsAt = calculateGraceEndsAtDays(dueDate, graceDays);
      const isInGrace = paid < amt && now >= dueDate && now < graceEndsAt;

      let status: 'PENDIENTE' | 'PARCIAL' | 'PAGADA' | 'VENCIDA' = 'PENDIENTE';
      if (paid >= amt) {
        status = 'PAGADA';
      } else if (now >= graceEndsAt) {
        status = 'VENCIDA';
        overdueAmount += amt - paid;
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
          status,
        };
      }

      return {
        id: inst.id,
        installmentNumber: inst.installmentNumber,
        dueDate: toManaguaDateString(dueDate),
        dueDateIso: dueDate.toISOString(),
        graceEndsAt: toManaguaDateString(graceEndsAt),
        isInGrace,
        amount: amt,
        paidAmount: paid,
        pendingAmount: Math.round((amt - paid) * 100) / 100,
        status,
        paidAt: inst.paidAt ? inst.paidAt.toISOString() : null,
        paymentId: (inst as any).paymentId ?? null,
      };
    });

    overdueAmount = Math.round(overdueAmount * 100) / 100;

    // 3. Estado de mantenimiento
    const maintInfo = this.computeMaintenanceSummary(agreement, business.memberships, coverage, now);

    const equipmentMapped = agreement.equipment.map((e) => ({
      id: e.id,
      agreementId: e.agreementId,
      businessId: e.businessId,
      name: (e as any).name || [e.brand, e.model].filter(Boolean).join(' ').trim() || e.description || e.equipmentType,
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
    }));

    const equipmentTotal =
      Math.round(
        equipmentMapped.reduce((acc, item) => acc + (item.price != null ? item.price : 0), 0) * 100,
      ) / 100;

    return {
      agreement: {
        id: agreement.id,
        businessId: agreement.businessId,
        saleModality: agreement.saleModality,
        publicSaleModality: toPublicSaleModality(agreement.saleModality),
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
        saleDate: toManaguaDateString(new Date(agreement.activatedAt)),
        maintenanceFreeMonths: agreement.maintenanceFreeMonths,
        maintenanceFreeEndsAt: maintInfo.includedUntil,
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
        currency: (p as any).currency || agreement.currency || 'USD',
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
      equipment: equipmentMapped,
      summary: {
        totalPaid,
        balance,
        equipmentTotal,
        overdueAmount,
        overdueInstallments,
        nextInstallment,
        maintenance: {
          status: maintInfo.legacyStatus,
          detailedStatus: maintInfo.status,
          endsAt: maintInfo.includedUntil,
          includedUntil: maintInfo.includedUntil,
          nextChargeDate: maintInfo.nextChargeDate,
          daysLeft: maintInfo.daysUntilDue,
          feeNio: Number(agreement.maintenanceFeeNio),
          currency: 'NIO',
          currentChargeDue: maintInfo.currentChargeDue,
        },
        coverage: {
          source: coverage.source,
          coveredUntil: coverage.coveredUntilStr,
          blocked: coverage.isCommercialBlocked || !coverage.isCovered,
          commercialBlocked: coverage.isCommercialBlocked,
          blockReason: coverage.blockReason,
          blockMessage: coverage.blockMessage,
        },
      },
    };
  }

  /**
   * 302a - Estado de cuenta completo del cliente (funciona para membresía y pago único).
   */
  async getAccountStatement(businessId: string, now: Date = new Date()) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        commercialAgreement: {
          include: {
            installments: { orderBy: { installmentNumber: 'asc' } },
            payments: { orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }] },
            equipment: { orderBy: { createdAt: 'asc' } },
          },
        },
        memberships: {
          where: { status: { not: MembershipStatus.CANCELLED } },
          orderBy: [{ endDate: 'desc' }, { startDate: 'desc' }],
        },
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const coverage = await resolveBusinessCoverage(this.prisma, businessId, now);
    const agreement = business.commercialAgreement;

    const membershipPayments = (business.memberships || [])
      .filter((m) => m.type !== MembershipType.TRIAL)
      .map((m) => ({
        id: m.id,
        source: 'MEMBERSHIP' as const,
        kind:
          agreement && agreement.saleModality !== CommercialSaleModality.MEMBRESIA_MENSUAL
            ? 'MANTENIMIENTO'
            : 'MEMBRESIA',
        amount: Number(m.amount),
        currency: m.currency || 'USD',
        paymentMethod: m.paymentMethod,
        paymentProofUrl: m.paymentProofUrl,
        paidAt: toManaguaDateString(new Date(m.paidAt || m.startDate)),
        periodStart: toManaguaDateString(new Date(m.startDate)),
        periodEnd: toManaguaDateString(new Date(m.endDate)),
        notes: m.notes,
        voidedAt: null,
        createdAt: m.createdAt.toISOString(),
      }));

    if (!agreement || agreement.saleModality === CommercialSaleModality.MEMBRESIA_MENSUAL) {
      const totalPaid =
        Math.round(membershipPayments.reduce((acc, p) => acc + p.amount, 0) * 100) / 100;
      const currency = membershipPayments[0]?.currency || 'USD';

      return {
        businessId: business.id,
        businessName: business.name,
        saleModality: 'MEMBRESIA' as const,
        rawSaleModality: CommercialSaleModality.MEMBRESIA_MENSUAL,
        paymentType: 'MENSUAL' as const,
        status: coverage.status,
        currency,
        saleDate: toManaguaDateString(business.createdAt),
        notes: agreement?.notes ?? null,
        totalPrice: null,
        totalPaid,
        balance: 0,
        downPayment: 0,
        financedBalance: 0,
        equipmentTotal: 0,
        installments: [],
        upcomingInstallments: [],
        maintenance: {
          applies: false,
          status: 'NO_APLICA' as const,
          includedUntil: null,
          nextChargeDate: null,
          monthlyAmount: null,
          currency: 'NIO' as const,
          currentChargeDue: null,
          graceEndsAt: null,
          daysUntilDue: null,
        },
        equipment: [],
        payments: membershipPayments,
        billingStatus: {
          isBlocked: !coverage.isCovered && coverage.source !== null,
          isCommercialBlocked: coverage.isCommercialBlocked,
          blockReason: coverage.blockReason,
          blockMessage: coverage.blockMessage,
          isInGrace: coverage.isInGrace,
          graceEndsAt: coverage.graceEndsAtStr,
          coveredUntil: coverage.coveredUntilStr,
          coverageSource: coverage.source,
          daysUntilDue: coverage.daysUntilDue,
          billingAnchorDay: business.billingAnchorDay ?? null,
        },
      };
    }

    const commercialData = await this.getCommercialAgreement(businessId, now);
    const maintInfo = this.computeMaintenanceSummary(
      agreement,
      business.memberships,
      coverage,
      now,
    );

    const commercialPayments = (commercialData?.payments || []).map((p) => ({
      id: p.id,
      source: 'COMMERCIAL' as const,
      kind: p.kind,
      amount: p.amount,
      currency: p.currency,
      paymentMethod: p.paymentMethod,
      referenceNumber: p.referenceNumber,
      paymentProofUrl: p.paymentProofUrl,
      paidAt: p.paidAt,
      periodStart: null,
      periodEnd: null,
      notes: p.notes,
      voidedAt: p.voidedAt,
      createdAt: p.createdAt,
    }));

    const allPayments = [...commercialPayments, ...membershipPayments].sort(
      (a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime(),
    );

    const installments = commercialData?.installments || [];
    const upcomingInstallments = installments.filter((i) => i.status !== 'PAGADA');

    return {
      businessId: business.id,
      businessName: business.name,
      agreementId: agreement.id,
      saleModality: toPublicSaleModality(agreement.saleModality),
      rawSaleModality: agreement.saleModality,
      paymentType: agreement.paymentType,
      status: agreement.status,
      currency: agreement.currency,
      saleDate: toManaguaDateString(new Date(agreement.activatedAt)),
      notes: agreement.notes,
      totalPrice: Number(agreement.totalPrice),
      totalPaid: commercialData?.summary.totalPaid ?? 0,
      balance: commercialData?.summary.balance ?? 0,
      downPayment: Number(agreement.downPayment),
      financedBalance: Number(agreement.financedBalance),
      equipmentTotal: commercialData?.summary.equipmentTotal ?? 0,
      installments,
      upcomingInstallments,
      maintenance: {
        applies: agreement.maintenanceFreeMonths > 0 || Number(agreement.maintenanceFeeNio) > 0,
        status: maintInfo.status,
        includedUntil: maintInfo.includedUntil,
        nextChargeDate: maintInfo.nextChargeDate,
        monthlyAmount: Number(agreement.maintenanceFeeNio),
        currency: 'NIO' as const,
        currentChargeDue: maintInfo.currentChargeDue,
        graceEndsAt: coverage.graceEndsAtStr,
        daysUntilDue: maintInfo.daysUntilDue,
      },
      equipment: commercialData?.equipment || [],
      payments: allPayments,
      billingStatus: {
        isBlocked: coverage.isCommercialBlocked || !coverage.isCovered,
        isCommercialBlocked: coverage.isCommercialBlocked,
        blockReason: coverage.blockReason,
        blockMessage: coverage.blockMessage,
        isInGrace: coverage.isInGrace,
        graceEndsAt: coverage.graceEndsAtStr,
        coveredUntil: coverage.coveredUntilStr,
        coverageSource: coverage.source,
        daysUntilDue: coverage.daysUntilDue,
        billingAnchorDay: business.billingAnchorDay ?? null,
      },
    };
  }

  private computeMaintenanceSummary(
    agreement: any,
    memberships: any[],
    coverage: any,
    now: Date,
  ) {
    if (
      !agreement ||
      agreement.saleModality === CommercialSaleModality.MEMBRESIA_MENSUAL ||
      !agreement.maintenanceFreeEndsAt
    ) {
      return {
        status: 'NO_APLICA' as const,
        legacyStatus: 'NO_APLICA' as const,
        includedUntil: null as string | null,
        nextChargeDate: null as string | null,
        daysUntilDue: null as number | null,
        currentChargeDue: null as {
          amount: number;
          currency: 'NIO';
          dueDate: string;
          graceEndsAt: string | null;
        } | null,
      };
    }

    const mEndsAt = new Date(agreement.maintenanceFreeEndsAt);
    const includedUntil = toManaguaDateString(mEndsAt);
    const monthlyAmount = Number(agreement.maintenanceFeeNio);

    const paidMaint = (memberships || []).filter(
      (m) => m.status !== MembershipStatus.CANCELLED && m.type !== MembershipType.TRIAL,
    );

    const daysUntilFreeEnds = calculateDaysUntilDue(mEndsAt, now);

    // Aún dentro de los 12 meses incluidos (antes de la fecha de corte)
    if (daysUntilFreeEnds > 0) {
      return {
        status: 'INCLUIDO' as const,
        legacyStatus: 'INCLUIDO' as const,
        includedUntil,
        nextChargeDate: includedUntil,
        daysUntilDue: daysUntilFreeEnds,
        currentChargeDue: null,
      };
    }

    // Mes 13 en adelante: verificar si hay pagos de mantenimiento cubriendo el período actual
    if (paidMaint.length > 0 && coverage.source === 'MEMBERSHIP') {
      const nextDueStr = coverage.coveredUntilStr || includedUntil;
      const days = coverage.daysUntilDue ?? 0;

      if (!coverage.isCovered && !coverage.isCommercialBlocked) {
        return {
          status: 'VENCIDO' as const,
          legacyStatus: 'EN_COBRO' as const,
          includedUntil,
          nextChargeDate: nextDueStr,
          daysUntilDue: days,
          currentChargeDue: {
            amount: monthlyAmount,
            currency: 'NIO' as const,
            dueDate: nextDueStr,
            graceEndsAt: coverage.graceEndsAtStr,
          },
        };
      }

      if (coverage.isInGrace || days <= 0) {
        return {
          status: 'EN_GRACIA' as const,
          legacyStatus: 'EN_COBRO' as const,
          includedUntil,
          nextChargeDate: nextDueStr,
          daysUntilDue: days,
          currentChargeDue: {
            amount: monthlyAmount,
            currency: 'NIO' as const,
            dueDate: nextDueStr,
            graceEndsAt: coverage.graceEndsAtStr,
          },
        };
      }

      return {
        status: 'EN_COBRO' as const,
        legacyStatus: 'EN_COBRO' as const,
        includedUntil,
        nextChargeDate: nextDueStr,
        daysUntilDue: days,
        currentChargeDue: null,
      };
    }

    // Mes 13 alcanzado y aún no hay ningún pago mensual registrado
    const mGrace = calculateGraceEndsAt(mEndsAt);
    const isExpired = now >= mGrace;

    return {
      status: isExpired ? ('VENCIDO' as const) : ('EN_COBRO' as const),
      legacyStatus: 'EN_COBRO' as const,
      includedUntil,
      nextChargeDate: includedUntil,
      daysUntilDue: daysUntilFreeEnds,
      currentChargeDue: {
        amount: monthlyAmount,
        currency: 'NIO' as const,
        dueDate: includedUntil,
        graceEndsAt: mGrace.toISOString(),
      },
    };
  }

  /**
   * Crea un acuerdo comercial (con cuotas, equipo y pago inicial opcional) dentro de una transacción.
   * Usado tanto por el asistente "Crear nuevo negocio" (todo o nada) como por upsertCommercialAgreement.
   */
  async createAgreementInTransaction(
    tx: Prisma.TransactionClient,
    businessId: string,
    currentBillingAnchorDay: number | null | undefined,
    dto: UpsertCommercialAgreementDto,
    user: { sub: string; role: string },
  ) {
    const pricingConfig = await this.getPricingConfig(tx);
    const saleModality = normalizeSaleModality(dto.saleModality);
    const paymentType = dto.paymentType || 'CONTADO';
    const currency = dto.currency || 'USD';

    if (currency !== 'USD' && currency !== 'NIO') {
      throw new BadRequestException('La moneda debe ser USD o NIO.');
    }

    const equipmentList = Array.isArray(dto.equipment) ? dto.equipment : [];

    // Validar regla de precios de equipo según modalidad
    if (saleModality === CommercialSaleModality.COMBO_COMPLETO) {
      for (const eq of equipmentList) {
        if (eq.price !== undefined && eq.price !== null && Number(eq.price) > 0) {
          throw new BadRequestException(
            'En combo completo el precio es del combo y las piezas van sin precio individual.',
          );
        }
      }
    }

    const equipmentSum =
      Math.round(
        equipmentList.reduce(
          (acc, eq) => acc + (eq.price !== undefined && eq.price !== null ? Number(eq.price) : 0),
          0,
        ) * 100,
      ) / 100;

    // Resolver precio total (usando referencia centralizada o suma de piezas en combo parcial)
    let totalPrice: number;
    if (dto.totalPrice !== undefined && dto.totalPrice !== null) {
      totalPrice = Math.round(Number(dto.totalPrice) * 100) / 100;
    } else if (saleModality === CommercialSaleModality.PAGO_UNICO_SISTEMA) {
      totalPrice = pricingConfig.soloSistemaPriceUsd;
    } else if (saleModality === CommercialSaleModality.COMBO_COMPLETO) {
      totalPrice = pricingConfig.comboCompletoPriceUsd;
    } else if (saleModality === CommercialSaleModality.COMBO_PARCIAL && equipmentSum > 0) {
      totalPrice = equipmentSum;
    } else {
      throw new BadRequestException(
        'Debés indicar el precio total del acuerdo comercial (o los precios de las piezas en combo parcial).',
      );
    }

    if (totalPrice <= 0 && saleModality !== CommercialSaleModality.MEMBRESIA_MENSUAL) {
      throw new BadRequestException('El precio total del acuerdo debe ser mayor a 0.');
    }

    const isCredit = paymentType === 'CREDITO';
    let downPayment = 0;
    if (isCredit) {
      if (dto.downPayment !== undefined && dto.downPayment !== null) {
        downPayment = Math.round(Number(dto.downPayment) * 100) / 100;
      } else {
        downPayment =
          Math.round(totalPrice * (pricingConfig.defaultCreditDownPaymentPct / 100) * 100) / 100;
      }
      if (downPayment >= totalPrice) {
        throw new BadRequestException(
          'En venta a crédito la prima debe ser menor al precio total. Para pago total usá CONTADO.',
        );
      }
    }

    const financedBalance = isCredit
      ? Math.max(0, Math.round((totalPrice - downPayment) * 100) / 100)
      : 0;

    let installmentsCount = 0;
    if (isCredit) {
      installmentsCount =
        dto.installmentsCount !== undefined && dto.installmentsCount !== null
          ? dto.installmentsCount
          : pricingConfig.maxCreditInstallments;
      if (installmentsCount < 1 || installmentsCount > pricingConfig.maxCreditInstallments) {
        throw new BadRequestException(
          `El número de cuotas a crédito debe estar entre 1 y ${pricingConfig.maxCreditInstallments}.`,
        );
      }
    }

    const rawSaleDate = dto.saleDate || dto.activatedAt;
    const actDate = rawSaleDate
      ? parseManaguaDate(rawSaleDate) || new Date(rawSaleDate)
      : new Date();
    const actParts = getManaguaDateParts(actDate);
    const normalizedActDate = createManaguaDate(actParts.year, actParts.month, actParts.day, 0, 0, 0, 0);

    const maintMonths =
      saleModality === CommercialSaleModality.MEMBRESIA_MENSUAL
        ? 0
        : dto.maintenanceFreeMonths !== undefined
          ? dto.maintenanceFreeMonths
          : pricingConfig.maintenanceFreeMonths;

    const maintEndsAt =
      maintMonths > 0 ? addMonthsManagua(normalizedActDate, maintMonths, actParts.day) : null;

    const maintenanceFeeNio =
      dto.maintenanceFeeNio !== undefined && dto.maintenanceFeeNio !== null
        ? Math.round(Number(dto.maintenanceFeeNio) * 100) / 100
        : pricingConfig.maintenanceMonthlyNio;

    const graceDays =
      dto.graceDays !== undefined && dto.graceDays !== null
        ? dto.graceDays
        : pricingConfig.defaultGraceDays;

    let firstInstDate: Date | null = null;
    if (isCredit && financedBalance > 0) {
      firstInstDate = dto.firstInstallmentDate
        ? parseManaguaDate(dto.firstInstallmentDate) || new Date(dto.firstInstallmentDate)
        : addMonthsManagua(normalizedActDate, 1, actParts.day);
    }

    // Fijar billingAnchorDay si aún no existe
    if (!currentBillingAnchorDay) {
      await tx.business.update({
        where: { id: businessId },
        data: { billingAnchorDay: actParts.day },
      });
    }

    const agreement = await tx.businessCommercialAgreement.create({
      data: {
        businessId,
        saleModality,
        paymentType,
        status: 'VIGENTE',
        totalPrice: new Prisma.Decimal(totalPrice),
        currency,
        downPayment: new Prisma.Decimal(downPayment),
        financedBalance: new Prisma.Decimal(financedBalance),
        installmentsCount,
        firstInstallmentDate: firstInstDate,
        graceDays,
        activatedAt: normalizedActDate,
        maintenanceFreeMonths: maintMonths,
        maintenanceFreeEndsAt: maintEndsAt,
        maintenanceFeeNio: new Prisma.Decimal(maintenanceFeeNio),
        installationDoneAt: dto.installationDoneAt
          ? parseManaguaDate(dto.installationDoneAt) || new Date(dto.installationDoneAt)
          : null,
        trainingDoneAt: dto.trainingDoneAt
          ? parseManaguaDate(dto.trainingDoneAt) || new Date(dto.trainingDoneAt)
          : null,
        notes: dto.notes,
        createdBy: user.sub,
      },
    });

    // Generar calendario de cuotas si es crédito
    if (isCredit && installmentsCount > 0 && financedBalance > 0 && firstInstDate) {
      await this.generateInstallments(
        tx,
        agreement.id,
        financedBalance,
        installmentsCount,
        firstInstDate,
        actParts.day,
      );
    }

    // Crear piezas de equipo si vinieron en la creación
    for (const eqDto of equipmentList) {
      await this.createEquipmentInTx(tx, agreement, eqDto, user);
    }

    // Registrar pago inicial (prima o contado) si se proporcionó
    if (dto.initialPayment) {
      const initPay = dto.initialPayment;
      const normalizedKind = normalizeCommercialPaymentKind(
        initPay.kind || (isCredit ? 'ADELANTO' : 'PAGO'),
      );
      if (normalizedKind === 'MANTENIMIENTO') {
        throw new BadRequestException(
          'El pago inicial de una venta no puede ser de tipo MANTENIMIENTO.',
        );
      }

      const payCurrency = initPay.currency || currency;
      if (payCurrency !== currency) {
        throw new BadRequestException(
          `La moneda del pago (${payCurrency}) no coincide con la moneda del acuerdo (${currency}). No se convierten monedas automáticamente.`,
        );
      }

      const payAmount = Math.round(Number(initPay.amount) * 100) / 100;
      if (payAmount <= 0) {
        throw new BadRequestException('El monto del pago inicial debe ser mayor a 0.');
      }
      if (payAmount > totalPrice) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'PAYMENT_EXCEEDS_BALANCE',
          message: `El monto del pago inicial (${payCurrency} ${payAmount.toFixed(2)}) supera el precio total (${currency} ${totalPrice.toFixed(2)}).`,
        });
      }
      if (normalizedKind === 'ADELANTO' && isCredit && payAmount > downPayment) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'PAYMENT_EXCEEDS_BALANCE',
          message: `El monto de la prima (${payCurrency} ${payAmount.toFixed(2)}) supera la prima pactada (${currency} ${downPayment.toFixed(2)}).`,
        });
      }

      const paidDate = initPay.paidAt
        ? parseManaguaDate(initPay.paidAt) || new Date(initPay.paidAt)
        : normalizedActDate;

      await tx.commercialPayment.create({
        data: {
          agreementId: agreement.id,
          kind: normalizedKind as CommercialPaymentKind,
          amount: new Prisma.Decimal(payAmount),
          currency: payCurrency,
          paymentMethod: initPay.paymentMethod || PaymentMethod.TRANSFERENCIA,
          referenceNumber: initPay.referenceNumber,
          paymentProofUrl: initPay.paymentProofUrl,
          paidAt: paidDate,
          paidAmountNio:
            initPay.paidAmountNio != null ? new Prisma.Decimal(initPay.paidAmountNio) : null,
          exchangeRate:
            initPay.exchangeRate != null ? new Prisma.Decimal(initPay.exchangeRate) : null,
          notes: initPay.notes || (isCredit ? 'Prima inicial' : 'Pago de contado'),
          registeredBy: user.sub,
        },
      });

      if (normalizedKind === 'CUOTA' || normalizedKind === 'PAGO') {
        await this.recalculateInstallmentsInternal(tx, agreement.id);
      }

      if (Math.round((totalPrice - payAmount) * 100) / 100 <= 0) {
        await tx.businessCommercialAgreement.update({
          where: { id: agreement.id },
          data: { status: 'LIQUIDADO' },
        });
      }
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
          saleModality,
          paymentType,
          totalPrice,
          currency,
          downPayment,
          financedBalance,
          installmentsCount,
          maintenanceFeeNio,
          maintenanceFreeEndsAt: maintEndsAt ? toManaguaDateString(maintEndsAt) : null,
        },
        reason: 'Creación de acuerdo comercial para negocio',
      },
      tx,
    );

    return agreement;
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

    if (!existing) {
      if (!dto.saleModality) {
        throw new BadRequestException('saleModality es obligatorio al crear el acuerdo comercial');
      }
      await this.prisma.$transaction(async (tx) => {
        await this.createAgreementInTransaction(
          tx,
          businessId,
          business.billingAnchorDay,
          dto,
          user,
        );
      });
      return this.getCommercialAgreement(businessId);
    }

    const pricingConfig = await this.getPricingConfig();
    const saleModality = dto.saleModality
      ? normalizeSaleModality(dto.saleModality)
      : existing.saleModality;
    const paymentType = dto.paymentType || existing.paymentType || 'CONTADO';
    const currency = dto.currency || existing.currency || 'USD';
    const totalPrice =
      dto.totalPrice !== undefined
        ? Math.round(Number(dto.totalPrice) * 100) / 100
        : Number(existing.totalPrice);

    // Bloqueo de términos si ya hay pagos válidos registrados
    if (existing.payments.length > 0) {
      const requestedDownPayment =
        dto.downPayment !== undefined ? Number(dto.downPayment) : Number(existing.downPayment);
      const requestedInstallmentsCount =
        dto.installmentsCount !== undefined ? dto.installmentsCount : existing.installmentsCount;

      const termsChanged =
        existing.saleModality !== saleModality ||
        existing.paymentType !== paymentType ||
        existing.currency !== currency ||
        Number(existing.totalPrice) !== totalPrice ||
        Number(existing.downPayment) !== requestedDownPayment ||
        existing.installmentsCount !== requestedInstallmentsCount;

      if (termsChanged) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'AGREEMENT_TERMS_LOCKED',
          message:
            'No se pueden modificar los términos comerciales porque ya existen pagos registrados',
        });
      }
    }

    const isCredit = paymentType === 'CREDITO';
    let downPayment = 0;
    if (isCredit) {
      if (dto.downPayment !== undefined) {
        downPayment = Math.round(Number(dto.downPayment) * 100) / 100;
      } else {
        downPayment =
          Math.round(totalPrice * (pricingConfig.defaultCreditDownPaymentPct / 100) * 100) / 100;
      }
    }

    const financedBalance = isCredit
      ? Math.max(0, Math.round((totalPrice - downPayment) * 100) / 100)
      : 0;

    let installmentsCount = 0;
    if (isCredit) {
      installmentsCount =
        dto.installmentsCount !== undefined
          ? dto.installmentsCount
          : existing.installmentsCount || pricingConfig.maxCreditInstallments;
      if (installmentsCount < 1) installmentsCount = 1;
      if (installmentsCount > pricingConfig.maxCreditInstallments) {
        installmentsCount = pricingConfig.maxCreditInstallments;
      }
    }

    const rawSaleDate = dto.saleDate || dto.activatedAt;
    const actDate = rawSaleDate
      ? parseManaguaDate(rawSaleDate) || new Date(rawSaleDate)
      : existing.activatedAt;
    const actParts = getManaguaDateParts(actDate);

    const maintMonths =
      saleModality === CommercialSaleModality.MEMBRESIA_MENSUAL
        ? 0
        : dto.maintenanceFreeMonths !== undefined
          ? dto.maintenanceFreeMonths
          : existing.maintenanceFreeMonths;

    const maintEndsAt = maintMonths > 0 ? addMonthsManagua(actDate, maintMonths, actParts.day) : null;

    let firstInstDate: Date | null = null;
    if (isCredit && financedBalance > 0) {
      firstInstDate = dto.firstInstallmentDate
        ? parseManaguaDate(dto.firstInstallmentDate) || new Date(dto.firstInstallmentDate)
        : existing.firstInstallmentDate || addMonthsManagua(actDate, 1, actParts.day);
    }

    const maintenanceFeeNio =
      dto.maintenanceFeeNio !== undefined
        ? Math.round(Number(dto.maintenanceFeeNio) * 100) / 100
        : Number(existing.maintenanceFeeNio);

    return this.prisma
      .$transaction(async (tx) => {
        const beforeData = {
          saleModality: existing.saleModality,
          totalPrice: Number(existing.totalPrice),
          downPayment: Number(existing.downPayment),
          maintenanceFeeNio: Number(existing.maintenanceFeeNio),
          activatedAt: existing.activatedAt,
        };

        const agreement = await tx.businessCommercialAgreement.update({
          where: { id: existing.id },
          data: {
            saleModality,
            paymentType,
            totalPrice: new Prisma.Decimal(totalPrice),
            currency,
            downPayment: new Prisma.Decimal(downPayment),
            financedBalance: new Prisma.Decimal(financedBalance),
            installmentsCount,
            firstInstallmentDate: firstInstDate,
            graceDays: dto.graceDays !== undefined ? dto.graceDays : existing.graceDays,
            activatedAt: actDate,
            maintenanceFreeMonths: maintMonths,
            maintenanceFreeEndsAt: maintEndsAt,
            maintenanceFeeNio: new Prisma.Decimal(maintenanceFeeNio),
            installationDoneAt:
              dto.installationDoneAt !== undefined
                ? dto.installationDoneAt
                  ? parseManaguaDate(dto.installationDoneAt) || new Date(dto.installationDoneAt)
                  : null
                : existing.installationDoneAt,
            trainingDoneAt:
              dto.trainingDoneAt !== undefined
                ? dto.trainingDoneAt
                  ? parseManaguaDate(dto.trainingDoneAt) || new Date(dto.trainingDoneAt)
                  : null
                : existing.trainingDoneAt,
            notes: dto.notes !== undefined ? dto.notes : existing.notes,
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
              actParts.day,
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
              saleModality,
              totalPrice,
              downPayment,
              maintenanceFeeNio,
              activatedAt: actDate,
            },
            reason: 'Actualización de acuerdo comercial',
          },
          tx,
        );

        return agreement;
      })
      .then(() => this.getCommercialAgreement(businessId));
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
    preferredAnchorDay?: number,
  ) {
    const totalCents = Math.round(financedBalance * 100);
    const baseCents = Math.floor(totalCents / installmentsCount);
    const remainderCents = totalCents - baseCents * installmentsCount;

    const fParts = getManaguaDateParts(firstDueDate);
    const anchorDay = preferredAnchorDay ?? fParts.day;

    for (let k = 1; k <= installmentsCount; k++) {
      const instCents = k === installmentsCount ? baseCents + remainderCents : baseCents;
      const instDueDate =
        k === 1 ? firstDueDate : addMonthsManagua(firstDueDate, k - 1, anchorDay);

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
   * Registra un pago comercial (ADELANTO/PRIMA, CUOTA, PAGO) o de MANTENIMIENTO mensual (reutilizando Membership).
   */
  async recordPayment(
    agreementId: string,
    dto: CreateCommercialPaymentDto,
    user: JwtPayload,
  ) {
    const normalizedKind = normalizeCommercialPaymentKind(dto.kind);
    this.logger.log(
      `[recordPayment] agreementId=${agreementId}, kind=${normalizedKind}, amount=${dto.amount}`,
    );

    const agreement = await this.prisma.businessCommercialAgreement.findFirst({
      where: { OR: [{ id: agreementId }, { businessId: agreementId }] },
      include: {
        payments: { where: { voidedAt: null } },
        installments: { orderBy: { installmentNumber: 'asc' } },
        business: {
          include: {
            productSubscriptions: { where: { status: BusinessProductStatus.ACTIVE } },
            memberships: {
              where: { status: { not: MembershipStatus.CANCELLED } },
              orderBy: { endDate: 'desc' },
            },
          },
        },
      },
    });

    if (!agreement) {
      throw new NotFoundException('Acuerdo comercial no encontrado');
    }

    const payAmount = Math.round(Number(dto.amount) * 100) / 100;
    if (payAmount <= 0) {
      throw new BadRequestException('El monto debe ser mayor a 0');
    }

    const paidDate = dto.paidAt
      ? parseManaguaDate(dto.paidAt) || new Date(dto.paidAt)
      : new Date();

    // 302a - Pago de mantenimiento mensual (reutiliza tabla Membership en NIO)
    if (normalizedKind === 'MANTENIMIENTO') {
      const currency = dto.currency || 'NIO';
      if (currency !== 'NIO') {
        throw new BadRequestException(
          'El mantenimiento mensual se cobra en córdobas (NIO). No se convierten monedas automáticamente.',
        );
      }

      const business = agreement.business;
      const paidMemberships = (business.memberships || []).filter(
        (m) => m.type !== MembershipType.TRIAL,
      );
      const latestPaid = paidMemberships[0];
      const nowParts = getManaguaDateParts(paidDate);
      let startDateDate: Date;
      let anchorDay: number;

      if (latestPaid) {
        const lParts = getManaguaDateParts(latestPaid.endDate);
        startDateDate = createManaguaDate(lParts.year, lParts.month, lParts.day, 0, 0, 0, 0);
        anchorDay = business.billingAnchorDay ?? lParts.day;
      } else if (agreement.maintenanceFreeEndsAt) {
        const mParts = getManaguaDateParts(new Date(agreement.maintenanceFreeEndsAt));
        startDateDate = createManaguaDate(mParts.year, mParts.month, mParts.day, 0, 0, 0, 0);
        anchorDay = business.billingAnchorDay ?? mParts.day;
      } else {
        startDateDate = createManaguaDate(nowParts.year, nowParts.month, nowParts.day, 0, 0, 0, 0);
        anchorDay = business.billingAnchorDay ?? nowParts.day;
      }

      const endDateDate = calculateDueDate(startDateDate, anchorDay);
      const activeSubs = business.productSubscriptions || [];

      return this.prisma.$transaction(async (tx) => {
        const membership = await tx.membership.create({
          data: {
            businessId: business.id,
            type: MembershipType.PAID,
            startDate: startDateDate,
            endDate: endDateDate,
            amount: new Prisma.Decimal(payAmount),
            currency: 'NIO',
            paymentMethod: dto.paymentMethod || PaymentMethod.TRANSFERENCIA,
            paymentProofUrl: dto.paymentProofUrl || null,
            paidAt: paidDate,
            notes: dto.notes || 'Pago mensual de mantenimiento',
            status: MembershipStatus.ACTIVE,
            createdBy: user.sub,
            ...(activeSubs.length > 0
              ? {
                  paymentProducts: {
                    create: activeSubs.map((sub) => ({
                      businessProductSubscriptionId: sub.id,
                      amountAttributed: null,
                    })),
                  },
                }
              : {}),
          },
        });

        if (!business.billingAnchorDay) {
          await tx.business.update({
            where: { id: business.id },
            data: { billingAnchorDay: anchorDay },
          });
        }

        await this.auditService.record(
          {
            businessId: business.id,
            userId: user.sub,
            userRole: user.role,
            action: 'COMMERCIAL_MAINTENANCE_PAYMENT_REGISTERED',
            entityType: 'Membership',
            entityId: membership.id,
            before: null,
            after: {
              membershipId: membership.id,
              amount: payAmount,
              currency: 'NIO',
              startDate: toManaguaDateString(startDateDate),
              endDate: toManaguaDateString(endDateDate),
            },
            reason: `Pago de mantenimiento registrado: C$${payAmount.toFixed(2)}`,
          },
          tx,
        );

        return {
          id: membership.id,
          source: 'MEMBERSHIP',
          kind: 'MANTENIMIENTO',
          amount: Number(membership.amount),
          currency: membership.currency,
          paymentMethod: membership.paymentMethod,
          paymentProofUrl: membership.paymentProofUrl,
          paidAt: toManaguaDateString(paidDate),
          periodStart: toManaguaDateString(startDateDate),
          periodEnd: toManaguaDateString(endDateDate),
          notes: membership.notes,
        };
      });
    }

    // Validar moneda sin conversión automática
    const payCurrency = dto.currency || agreement.currency || 'USD';
    if (payCurrency !== agreement.currency) {
      throw new BadRequestException(
        `La moneda del pago (${payCurrency}) no coincide con la moneda del acuerdo (${agreement.currency}). No se convierten monedas automáticamente.`,
      );
    }

    const totalPaid =
      Math.round(agreement.payments.reduce((acc, p) => acc + Number(p.amount), 0) * 100) / 100;
    const currentBalance = Math.max(
      0,
      Math.round((Number(agreement.totalPrice) - totalPaid) * 100) / 100,
    );

    if (payAmount > currentBalance) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'PAYMENT_EXCEEDS_BALANCE',
        message: `El monto del pago (${payCurrency} ${payAmount.toFixed(2)}) supera el saldo pendiente (${agreement.currency} ${currentBalance.toFixed(2)})`,
      });
    }

    if (normalizedKind === 'ADELANTO') {
      const downPaid =
        Math.round(
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
          message: `El monto de la prima (${payCurrency} ${payAmount.toFixed(2)}) supera la prima pendiente (${agreement.currency} ${remainingDown.toFixed(2)})`,
        });
      }
    }

    if (dto.installmentId) {
      const targetInst = agreement.installments.find((i) => i.id === dto.installmentId);
      if (!targetInst) {
        throw new NotFoundException('La cuota indicada no pertenece a este acuerdo comercial.');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.commercialPayment.create({
        data: {
          agreementId: agreement.id,
          kind: normalizedKind as CommercialPaymentKind,
          amount: new Prisma.Decimal(payAmount),
          currency: payCurrency,
          paymentMethod: dto.paymentMethod || PaymentMethod.TRANSFERENCIA,
          referenceNumber: dto.referenceNumber,
          paymentProofUrl: dto.paymentProofUrl,
          paidAt: paidDate,
          paidAmountNio:
            dto.paidAmountNio != null ? new Prisma.Decimal(dto.paidAmountNio) : null,
          exchangeRate:
            dto.exchangeRate != null ? new Prisma.Decimal(dto.exchangeRate) : null,
          notes: dto.notes,
          registeredBy: user.sub,
        },
      });

      // Recalcular cuotas FIFO y guardar paymentId asociado en cada cuota cubierta
      await this.recalculateInstallmentsInternal(tx, agreement.id);

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
          after: {
            paymentId: payment.id,
            amount: payAmount,
            currency: payCurrency,
            kind: normalizedKind,
            newBalance,
          },
          reason: `Pago comercial registrado: ${payCurrency} ${payAmount} (${normalizedKind})`,
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
      await tx.commercialPayment.update({
        where: { id: paymentId },
        data: {
          voidedAt: now,
          voidedBy: user.sub,
          voidReason: dto.reason,
        },
      });

      await this.recalculateInstallmentsInternal(tx, payment.agreementId);

      const nonVoided = await tx.commercialPayment.findMany({
        where: { agreementId: payment.agreementId, voidedAt: null },
      });
      const totalPaid =
        Math.round(nonVoided.reduce((acc, p) => acc + Number(p.amount), 0) * 100) / 100;
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
   * Recalcula desde cero todas las cuotas aplicando pagos válidos FIFO y guarda paymentId asociado.
   */
  private async recalculateInstallmentsInternal(
    tx: Prisma.TransactionClient,
    agreementId: string,
  ) {
    await tx.commercialInstallment.updateMany({
      where: { agreementId },
      data: {
        paidAmount: new Prisma.Decimal(0),
        paidAt: null,
        paymentId: null,
      },
    });

    const installments = await tx.commercialInstallment.findMany({
      where: { agreementId },
      orderBy: { installmentNumber: 'asc' },
    });

    if (installments.length === 0) return;

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
      paymentId: null as string | null,
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
          inst.paymentId = p.id;
          if (inst.paidCents >= inst.amountCents) {
            inst.paidAt = p.paidAt;
          }
        }
      }
    }

    for (const inst of instStates) {
      await tx.commercialInstallment.update({
        where: { id: inst.id },
        data: {
          paidAmount: new Prisma.Decimal(inst.paidCents / 100),
          paidAt: inst.paidAt,
          paymentId: inst.paymentId,
        },
      });
    }
  }

  private async createEquipmentInTx(
    tx: Prisma.TransactionClient,
    agreement: { id: string; businessId: string; saleModality: CommercialSaleModality },
    dto: CreateCommercialEquipmentDto,
    user: { sub: string; role: string },
  ) {
    const cleanName = (dto.name || '').trim();
    const cleanBrand = (dto.brand || '').trim();
    const cleanModel = (dto.model || '').trim();

    if (!cleanName && (!cleanBrand || !cleanModel)) {
      throw new BadRequestException(
        'Debés indicar el nombre de la pieza (o marca y modelo).',
      );
    }

    if (
      agreement.saleModality === CommercialSaleModality.COMBO_COMPLETO &&
      dto.price !== undefined &&
      dto.price !== null &&
      Number(dto.price) > 0
    ) {
      throw new BadRequestException(
        'En combo completo el precio es del combo y las piezas van sin precio individual.',
      );
    }

    const equipmentType = dto.equipmentType || CommercialEquipmentType.OTRO;
    const status = dto.status || (dto.deliveredAt ? 'ENTREGADO' : 'PENDIENTE');
    const serial = (dto.serialNumber || '').trim();

    // Solo exigir serie en tipos hardware clásicos si no se envió como pieza simple sin serie
    if (
      status === 'ENTREGADO' &&
      !cleanName &&
      SERIAL_REQUIRED_EQUIPMENT_TYPES.includes(equipmentType)
    ) {
      if (!serial) {
        throw new BadRequestException(
          `El número de serie es obligatorio para equipos de tipo ${equipmentType}`,
        );
      }
    }

    if (serial && status !== 'RETIRADO') {
      const duplicate = await tx.commercialEquipment.findFirst({
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
      ? parseManaguaDate(dto.deliveredAt) || new Date(dto.deliveredAt)
      : status === 'ENTREGADO'
        ? new Date()
        : null;

    const warDate = dto.warrantyEndsAt
      ? parseManaguaDate(dto.warrantyEndsAt) || new Date(dto.warrantyEndsAt)
      : null;

    const resolvedPrice =
      agreement.saleModality === CommercialSaleModality.COMBO_COMPLETO
        ? null
        : dto.price != null
          ? new Prisma.Decimal(dto.price)
          : null;

    const equipment = await tx.commercialEquipment.create({
      data: {
        agreementId: agreement.id,
        businessId: agreement.businessId,
        name: cleanName || [cleanBrand, cleanModel].filter(Boolean).join(' ').trim(),
        equipmentType,
        description: dto.description,
        brand: cleanBrand,
        model: cleanModel,
        serialNumber: serial,
        price: resolvedPrice,
        status,
        deliveredAt: delDate,
        warrantyEndsAt: warDate,
        notes: dto.notes,
      },
    });

    await this.auditService.record(
      {
        businessId: agreement.businessId,
        userId: user.sub,
        userRole: user.role,
        action: 'COMMERCIAL_EQUIPMENT_CREATED',
        entityType: 'CommercialEquipment',
        entityId: equipment.id,
        before: null,
        after: {
          name: equipment.name,
          equipmentType,
          serialNumber: serial,
          price: resolvedPrice != null ? Number(resolvedPrice) : null,
          status,
        },
        reason: `Equipo agregado: ${equipment.name} (${equipmentType})`,
      },
      tx,
    );

    return equipment;
  }

  /**
   * Agrega un equipo entregado con validación de serie único entre negocios.
   */
  async createEquipment(
    agreementId: string,
    dto: CreateCommercialEquipmentDto,
    user: JwtPayload,
  ) {
    this.logger.log(`[createEquipment] agreementId=${agreementId}, name=${dto.name || dto.equipmentType}`);

    const agreement = await this.prisma.businessCommercialAgreement.findFirst({
      where: { OR: [{ id: agreementId }, { businessId: agreementId }] },
      include: { business: true },
    });

    if (!agreement) {
      throw new NotFoundException('Acuerdo comercial no encontrado');
    }

    return this.prisma.$transaction(async (tx) => {
      return this.createEquipmentInTx(tx, agreement, dto, user);
    });
  }

  /**
   * Actualiza un equipo comercial (permite agregar/editar serie, fecha de entrega, precio o notas luego de crear).
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
        agreement: { select: { businessId: true, saleModality: true } },
      },
    });

    if (!equipment) {
      throw new NotFoundException('Equipo comercial no encontrado');
    }

    if (
      equipment.agreement.saleModality === CommercialSaleModality.COMBO_COMPLETO &&
      dto.price !== undefined &&
      dto.price !== null &&
      Number(dto.price) > 0
    ) {
      throw new BadRequestException(
        'En combo completo el precio es del combo y las piezas van sin precio individual.',
      );
    }

    const nextType = dto.equipmentType || equipment.equipmentType;
    const nextStatus = dto.status || equipment.status;
    const nextSerial =
      dto.serialNumber !== undefined ? dto.serialNumber.trim() : equipment.serialNumber;
    const hasPieceName = Boolean((dto.name ?? (equipment as any).name ?? '').trim());

    if (
      nextStatus === 'ENTREGADO' &&
      !hasPieceName &&
      SERIAL_REQUIRED_EQUIPMENT_TYPES.includes(nextType)
    ) {
      if (!nextSerial) {
        throw new BadRequestException(
          `El número de serie es obligatorio para equipos de tipo ${nextType}`,
        );
      }
    }

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

    const delDate =
      dto.deliveredAt !== undefined
        ? dto.deliveredAt
          ? parseManaguaDate(dto.deliveredAt) || new Date(dto.deliveredAt)
          : null
        : equipment.deliveredAt;

    const warDate =
      dto.warrantyEndsAt !== undefined
        ? dto.warrantyEndsAt
          ? parseManaguaDate(dto.warrantyEndsAt) || new Date(dto.warrantyEndsAt)
          : null
        : equipment.warrantyEndsAt;

    const updated = await this.prisma.commercialEquipment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.equipmentType && { equipmentType: dto.equipmentType }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.brand !== undefined && { brand: dto.brand }),
        ...(dto.model !== undefined && { model: dto.model }),
        ...(dto.serialNumber !== undefined && { serialNumber: nextSerial }),
        ...(dto.price !== undefined && {
          price: dto.price != null ? new Prisma.Decimal(dto.price) : null,
        }),
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
        name: (equipment as any).name,
        status: equipment.status,
        serialNumber: equipment.serialNumber,
      },
      after: {
        name: (updated as any).name,
        status: updated.status,
        serialNumber: updated.serialNumber,
      },
      reason: `Equipo actualizado id=${id}`,
    });

    return updated;
  }
}
