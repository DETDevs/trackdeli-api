import { Injectable, NotFoundException, BadRequestException, Logger, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto, CountedBreakdownDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";
import { MovementType, Prisma, UserRole } from "@prisma/client";
import { getSalePaymentBreakdown, parseCountedMethod } from "./pos-cash.utils";
import { PoliciesService } from '../policies/policies.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

@Injectable()
export class CashRegisterService {
  private readonly logger = new Logger(CashRegisterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policiesService: PoliciesService,
    private readonly auditService: AuditService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  private formatRegister(register: any) {
    if (!register) return null;
    const movements = (register.movements || []).map((m: any) => ({
      ...m,
      type: m.type === 'SALIDA' ? 'OUT' : (m.type === 'ENTRADA' ? 'IN' : m.type),
      rawType: m.type,
      reason: m.concept || m.reason || 'Movimiento de caja',
      concept: m.concept || m.reason || 'Movimiento de caja',
      amount: Number(new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0).toDecimalPlaces(2)),
      currency: m.currency || 'NIO',
      exchangeRate: m.exchangeRate != null ? Number(new Prisma.Decimal(m.exchangeRate.toString()).toDecimalPlaces(4)) : 1,
      amountBase: m.amountBase != null ? Number(new Prisma.Decimal(m.amountBase.toString()).toDecimalPlaces(2)) : 0,
    }));

    // Ventas para totalSales (ingresos netos):
    // COMPLETED, PARTIALLY_RETURNED y RETURNED suman neto (total menos reembolsos).
    // CANCELLED y VOIDED suman 0.
    const activeSales = (register.sales || []).filter((s: any) => 
      s.status === 'COMPLETED' || s.status === 'PARTIALLY_RETURNED' || s.status === 'RETURNED'
    );
    let decCalculatedSales = new Prisma.Decimal(0);
    let decCalculatedCashNio = new Prisma.Decimal(0);
    let decCalculatedCashUsd = new Prisma.Decimal(0);
    let decCalculatedCashUsdBase = new Prisma.Decimal(0);
    let decCalculatedCard = new Prisma.Decimal(0);
    let decCalculatedTransfer = new Prisma.Decimal(0);

    for (const s of activeSales) {
      const refundsTotal = (s.returns || []).reduce(
        (sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)),
        new Prisma.Decimal(0),
      );
      const netSaleTotal = Prisma.Decimal.max(0, new Prisma.Decimal(s.total != null ? s.total.toString() : 0).minus(refundsTotal));
      decCalculatedSales = decCalculatedSales.plus(netSaleTotal);
    }

    for (const s of (register.sales || [])) {
      const breakdown = getSalePaymentBreakdown(s);
      decCalculatedCashNio = decCalculatedCashNio.plus(new Prisma.Decimal(breakdown.cashNio));
      decCalculatedCashUsd = decCalculatedCashUsd.plus(new Prisma.Decimal(breakdown.cashUsd));
      decCalculatedCashUsdBase = decCalculatedCashUsdBase.plus(new Prisma.Decimal(breakdown.cashUsdBase));

      if (s.status !== 'CANCELLED' && s.status !== 'VOIDED') {
        const cardRefunds = (s.returns || [])
          .filter((r: any) => r.refundMethod === 'TARJETA')
          .reduce((sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)), new Prisma.Decimal(0));
        const transferRefunds = (s.returns || [])
          .filter((r: any) => r.refundMethod === 'TRANSFERENCIA')
          .reduce((sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)), new Prisma.Decimal(0));

        decCalculatedCard = decCalculatedCard.plus(Prisma.Decimal.max(0, new Prisma.Decimal(breakdown.card).minus(cardRefunds)));
        decCalculatedTransfer = decCalculatedTransfer.plus(Prisma.Decimal.max(0, new Prisma.Decimal(breakdown.transfer).minus(transferRefunds)));
      }
    }

    let decMovementsInNio = new Prisma.Decimal(0);
    let decMovementsOutNio = new Prisma.Decimal(0);
    let decMovementsInUsd = new Prisma.Decimal(0);
    let decMovementsOutUsd = new Prisma.Decimal(0);

    for (const m of movements) {
      const amt = new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0);
      const isUsd = (m.currency || '').toUpperCase() === 'USD';
      if (isUsd) {
        if (m.type === 'IN') decMovementsInUsd = decMovementsInUsd.plus(amt);
        if (m.type === 'OUT') decMovementsOutUsd = decMovementsOutUsd.plus(amt);
      } else {
        if (m.type === 'IN') decMovementsInNio = decMovementsInNio.plus(amt);
        if (m.type === 'OUT') decMovementsOutNio = decMovementsOutNio.plus(amt);
      }
    }

    const decInitialAmount = new Prisma.Decimal(register.openingCash ?? register.initialAmount ?? 0);

    const liveExpectedCash = decInitialAmount.plus(decCalculatedCashNio).plus(decMovementsInNio).minus(decMovementsOutNio);
    const expectedCashDec = register.expectedCash != null ? new Prisma.Decimal(register.expectedCash.toString()) : liveExpectedCash;

    const actualAmountDec = register.closingCash != null 
      ? new Prisma.Decimal(register.closingCash.toString()) 
      : (register.actualAmount != null ? new Prisma.Decimal(register.actualAmount.toString()) : null);

    const differenceDec = register.difference != null 
      ? new Prisma.Decimal(register.difference.toString()) 
      : (actualAmountDec != null ? actualAmountDec.minus(expectedCashDec) : null);

    const liveExpectedCashUsd = decCalculatedCashUsd.plus(decMovementsInUsd).minus(decMovementsOutUsd);
    const expectedCashUsdDec = register.expectedCashUsd != null ? new Prisma.Decimal(register.expectedCashUsd.toString()) : liveExpectedCashUsd;
    const closingCashUsdDec = register.closingCashUsd != null ? new Prisma.Decimal(register.closingCashUsd.toString()) : null;
    const differenceUsdDec = register.differenceUsd != null 
      ? new Prisma.Decimal(register.differenceUsd.toString()) 
      : (closingCashUsdDec != null ? closingCashUsdDec.minus(expectedCashUsdDec) : null);

    const cashierInfo = register.cashier
      ? { id: register.cashier.id, name: register.cashier.name }
      : (register.openedBy ?? null);

    const isClosed = register.status === 'CLOSED' || !!register.closedAt;
    const closedBy = isClosed ? cashierInfo : null;

    const initialAmount = Number(decInitialAmount.toDecimalPlaces(2));
    const expectedCash = Number(expectedCashDec.toDecimalPlaces(2));
    const actualAmount = actualAmountDec != null ? Number(actualAmountDec.toDecimalPlaces(2)) : null;
    const difference = differenceDec != null ? Number(differenceDec.toDecimalPlaces(2)) : null;

    const expectedCashUsd = Number(expectedCashUsdDec.toDecimalPlaces(2));
    const closingCashUsd = closingCashUsdDec != null ? Number(closingCashUsdDec.toDecimalPlaces(2)) : null;
    const differenceUsd = differenceUsdDec != null ? Number(differenceUsdDec.toDecimalPlaces(2)) : null;

    const totalSales = register.totalSales != null 
      ? Number(new Prisma.Decimal(register.totalSales.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedSales.toDecimalPlaces(2));
    const totalCash = register.totalCash != null 
      ? Number(new Prisma.Decimal(register.totalCash.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedCashNio.toDecimalPlaces(2));
    const totalCashUsd = register.totalCashUsd != null 
      ? Number(new Prisma.Decimal(register.totalCashUsd.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedCashUsd.toDecimalPlaces(2));
    const totalCard = register.totalCard != null 
      ? Number(new Prisma.Decimal(register.totalCard.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedCard.toDecimalPlaces(2));
    const totalTransfer = register.totalTransfer != null 
      ? Number(new Prisma.Decimal(register.totalTransfer.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedTransfer.toDecimalPlaces(2));
    const movementsIn = Number(decMovementsInNio.toDecimalPlaces(2));
    const movementsOut = Number(decMovementsOutNio.toDecimalPlaces(2));
    const movementsInUsd = Number(decMovementsInUsd.toDecimalPlaces(2));
    const movementsOutUsd = Number(decMovementsOutUsd.toDecimalPlaces(2));

    const closingBreakdown = (register.closingBreakdown as any) || {};
    const byMethodAndBank = closingBreakdown.byMethodAndBank || (closingBreakdown.CARD || closingBreakdown.TRANSFER || closingBreakdown.CASH ? closingBreakdown : this.calculateByMethodAndBank(register));
    const denominations = closingBreakdown.denominations || null;
    const countMode = closingBreakdown.countMode || (denominations?.length ? 'DENOMINATIONS' : 'TOTAL');

    const salesByChannel: Record<string, { count: number; total: number }> = {
      MOSTRADOR: { count: 0, total: 0 },
      DOMICILIO: { count: 0, total: 0 },
      PEDIDOSYA: { count: 0, total: 0 },
    };

    for (const s of activeSales) {
      const ch = (s.channel || 'MOSTRADOR').toUpperCase();
      if (!salesByChannel[ch]) {
        salesByChannel[ch] = { count: 0, total: 0 };
      }
      salesByChannel[ch].count += 1;
      const refundsTotal = (s.returns || []).reduce(
        (sum: number, r: any) => sum + (r.refundAmount != null ? Number(r.refundAmount) : 0),
        0,
      );
      const netTotal = Math.max(0, Number(s.total || 0) - refundsTotal);
      salesByChannel[ch].total = Math.round((salesByChannel[ch].total + netTotal) * 100) / 100;
    }

    return {
      ...register,
      openingCash: initialAmount,
      initialAmount,
      expectedCash,
      expectedAmount: expectedCash,
      closingCash: actualAmount,
      actualAmount,
      difference,
      expectedCashUsd,
      closingCashUsd,
      differenceUsd,
      totalSales,
      totalCash,
      totalCashUsd,
      totalCard,
      totalTransfer,
      movementsIn,
      movementsOut,
      movementsInUsd,
      movementsOutUsd,
      salesCount: activeSales.length || register._count?.sales || 0,
      salesByChannel,
      openedById: register.cashierId || register.openedById,
      openedBy: cashierInfo,
      closedBy,
      movements,
      sales: register.sales || [],
      byMethodAndBank,
      denominations,
      countMode,
      closingBreakdown: register.closingBreakdown || null,
    };
  }

  async obfuscateRegister(registerData: any, businessId: string, userRole?: string) {
    if (userRole !== 'CAJERO') return registerData;
    const policies = await this.policiesService.get(businessId);
    if (!policies.blindCashClose) return registerData;

    const obfuscateByMethodAndBank = (bmb: any) => {
      if (!bmb || typeof bmb !== 'object') return bmb;
      const obfuscated: any = {};
      for (const [method, val] of Object.entries(bmb)) {
        if (!val || typeof val !== 'object') {
          obfuscated[method] = val;
          continue;
        }
        const mVal: any = val;
        const methodObj: any = {
          reported: mVal.reported !== undefined ? mVal.reported : null,
        };
        if (Array.isArray(mVal.byBank)) {
          methodObj.byBank = mVal.byBank.map((b: any) => ({
            bankId: b.bankId,
            bankName: b.bankName,
            reported: b.reported !== undefined ? b.reported : null,
          }));
        }
        obfuscated[method] = methodObj;
      }
      return obfuscated;
    };

    const whitelistBlindRegister = (reg: any) => {
      if (!reg) return null;
      const isClosed = reg.status === 'CLOSED' || !!reg.closedAt;
      return {
        id: reg.id,
        businessId: reg.businessId,
        cashierId: reg.cashierId,
        openedAt: reg.openedAt,
        closedAt: reg.closedAt ?? null,
        status: reg.status,
        salesCount: reg.salesCount ?? (reg.sales ? reg.sales.length : 0),
        openedById: reg.openedById ?? reg.cashierId,
        openedBy: reg.openedBy ?? null,
        closedBy: isClosed ? (reg.closedBy ?? null) : null,
        notes: reg.notes ?? null,
        createdAt: reg.createdAt,
        cashier: reg.cashier ?? null,
        closingCash: reg.closingCash ?? reg.actualAmount ?? null,
        actualAmount: reg.closingCash ?? reg.actualAmount ?? null,
        closingCashUsd: reg.closingCashUsd ?? null,
        denominations: reg.denominations ?? reg.closingBreakdown?.denominations ?? null,
        countMode: reg.countMode ?? reg.closingBreakdown?.countMode ?? null,
        byMethodAndBank: obfuscateByMethodAndBank(reg.byMethodAndBank),
      };
    };

    if (registerData.register && registerData.summary) {
      return {
        register: whitelistBlindRegister(registerData.register),
        summary: {
          salesCount: registerData.summary.salesCount ?? 0,
          byMethodAndBank: obfuscateByMethodAndBank(registerData.summary.byMethodAndBank),
        },
      };
    }

    return whitelistBlindRegister(registerData);
  }

  async getCurrent(businessId: string, cashierId: string, userRole?: string) {
    let register = await this.prisma.cashRegister.findFirst({
      where: { businessId, cashierId, status: "OPEN" },
      include: {
        cashier: { select: { id: true, name: true } },
        movements: true,
        sales: {
          orderBy: { createdAt: "desc" },
          include: { payments: true, returns: { include: { items: true } } },
        },
        _count: { select: { sales: true } },
      },
      orderBy: { openedAt: "desc" },
    });

    if (!register) {
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          movements: true,
          sales: {
            orderBy: { createdAt: "desc" },
            include: { payments: true, returns: { include: { items: true } } },
          },
          _count: { select: { sales: true } },
        },
        orderBy: { openedAt: "desc" },
      });
    }

    if (!register) return null;
    return this.obfuscateRegister(this.formatRegister(register), businessId, userRole);
  }

  async findAll(businessId: string, userRole?: string) {
    const registers = await this.prisma.cashRegister.findMany({
      where: { businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        movements: true,
        sales: {
          orderBy: { createdAt: "desc" },
          include: { payments: true, returns: { include: { items: true } } },
        },
        _count: { select: { sales: true } },
      },
      orderBy: { openedAt: "desc" },
      take: 100,
    });
    const formatted = registers.map((r) => this.formatRegister(r));
    return Promise.all(formatted.map(f => this.obfuscateRegister(f, businessId, userRole)));
  }

  async open(dto: OpenCashRegisterDto, businessId: string, cashierId: string) {
    const existing = await this.prisma.cashRegister.findFirst({
      where: { businessId, cashierId, status: "OPEN" },
    });
    if (existing) {
      throw new BadRequestException("Ya tienes una caja abierta. Ciérrala antes de abrir una nueva.");
    }

    const openingCash = Number(dto.openingCash ?? dto.initialAmount ?? dto.amount ?? 0);
    this.logger.log(`[open] cashier=${cashierId} businessId=${businessId} openingCash=${openingCash}`);
    const created = await this.prisma.cashRegister.create({
      data: { businessId, cashierId, openingCash, notes: dto.notes },
      include: {
        cashier: { select: { id: true, name: true } },
        movements: true,
        sales: { include: { payments: true, returns: { include: { items: true } } } },
      },
    });
    return this.formatRegister(created);
  }

  async close(registerId: string | null | undefined, dto: CloseCashRegisterDto, businessId: string, cashierId?: string, userRole?: string) {
    let register;
    if (registerId && registerId !== 'close' && registerId !== 'current') {
      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId, businessId, status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          sales: { include: { payments: true, returns: { include: { items: true } } } },
          movements: true,
        },
      });
    } else {
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, ...(cashierId ? { cashierId } : {}), status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          sales: { include: { payments: true, returns: { include: { items: true } } } },
          movements: true,
        },
        orderBy: { openedAt: "desc" },
      });
    }

    if (!register) throw new NotFoundException("Caja no encontrada o ya cerrada");

    if (registerId && userRole === UserRole.CAJERO && register.cashierId !== cashierId) {
      throw new ForbiddenException(
        dto.reason
          ? 'Solo el encargado puede forzar el cierre de turno de otro usuario'
          : 'Solo el encargado puede cerrar el turno de otro usuario',
      );
    }

    const policies = await this.policiesService.get(businessId);
    let closingCashDec = new Prisma.Decimal(0);

    const denominations = dto.denominations || dto.counted?.denominations || null;
    const countMode = dto.countMode || dto.counted?.countMode || (denominations?.length ? 'DENOMINATIONS' : 'TOTAL');

    if (typeof (dto as any).counted === 'number') {
      closingCashDec = new Prisma.Decimal((dto as any).counted);
    } else if (dto.counted && dto.counted.CASH !== undefined) {
      closingCashDec = new Prisma.Decimal(dto.counted.CASH);
    } else if (dto.closingCash !== undefined || dto.actualAmount !== undefined || dto.amount !== undefined) {
      closingCashDec = new Prisma.Decimal(dto.closingCash ?? dto.actualAmount ?? dto.amount ?? 0);
    } else if (denominations && denominations.length > 0) {
      const dTotal = denominations.reduce((sum: number, d: any) => sum + (Number(d.value) * Number(d.qty)), 0);
      closingCashDec = new Prisma.Decimal(dTotal);
    }

    if (countMode === 'DENOMINATIONS' || (denominations && denominations.length > 0)) {
      const denomTotal = (denominations || []).reduce(
        (sum: number, d: any) => sum + (Number(d.value) * Number(d.qty)),
        0,
      );
      if (Math.abs(denomTotal - Number(closingCashDec)) > 0.01) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'DENOMINATIONS_MISMATCH',
          message: `El total de billetes y monedas (${denomTotal.toFixed(2)}) no coincide con el efectivo contado (${Number(closingCashDec).toFixed(2)})`,
        });
      }
    }

    let closingCashUsdDec: Prisma.Decimal | null = null;
    if (dto.closingCashUsd !== undefined && dto.closingCashUsd !== null) {
      closingCashUsdDec = new Prisma.Decimal(dto.closingCashUsd.toString());
    } else if (dto.counted && dto.counted.CASH_USD !== undefined) {
      closingCashUsdDec = new Prisma.Decimal(dto.counted.CASH_USD.toString());
    }

    let totalSalesDec = new Prisma.Decimal(0);
    let totalCashDec = new Prisma.Decimal(0);
    let totalCashUsdDec = new Prisma.Decimal(0);
    let totalCardDec = new Prisma.Decimal(0);
    let totalTransferDec = new Prisma.Decimal(0);
    let totalOtherDec = new Prisma.Decimal(0);
    let totalCreditDec = new Prisma.Decimal(0);

    for (const s of register.sales) {
      if (s.status !== 'CANCELLED' && s.status !== 'VOIDED') {
        const refundsTotal = (s.returns || []).reduce(
          (sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)),
          new Prisma.Decimal(0),
        );
        const netSale = Prisma.Decimal.max(0, new Prisma.Decimal(s.total != null ? s.total.toString() : 0).minus(refundsTotal));
        totalSalesDec = totalSalesDec.plus(netSale);

        const cardRefunds = (s.returns || [])
          .filter((r: any) => r.refundMethod === 'TARJETA')
          .reduce((sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)), new Prisma.Decimal(0));
        const transferRefunds = (s.returns || [])
          .filter((r: any) => r.refundMethod === 'TRANSFERENCIA')
          .reduce((sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)), new Prisma.Decimal(0));

        const breakdown = getSalePaymentBreakdown(s);
        totalCardDec = totalCardDec.plus(Prisma.Decimal.max(0, new Prisma.Decimal(breakdown.card).minus(cardRefunds)));
        totalTransferDec = totalTransferDec.plus(Prisma.Decimal.max(0, new Prisma.Decimal(breakdown.transfer).minus(transferRefunds)));
        totalOtherDec = totalOtherDec.plus(new Prisma.Decimal(breakdown.other));
        totalCreditDec = totalCreditDec.plus(new Prisma.Decimal(breakdown.credit));
      }

      const breakdown = getSalePaymentBreakdown(s);
      totalCashDec = totalCashDec.plus(new Prisma.Decimal(breakdown.cashNio));
      totalCashUsdDec = totalCashUsdDec.plus(new Prisma.Decimal(breakdown.cashUsd));
    }

    let movementsInNioDec = new Prisma.Decimal(0);
    let movementsOutNioDec = new Prisma.Decimal(0);
    let movementsInUsdDec = new Prisma.Decimal(0);
    let movementsOutUsdDec = new Prisma.Decimal(0);

    for (const m of register.movements) {
      const amt = new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0);
      const isUsd = (m.currency || '').toUpperCase() === 'USD';
      if (isUsd) {
        if (m.type === "ENTRADA" || (m as any).type === "IN") {
          movementsInUsdDec = movementsInUsdDec.plus(amt);
        }
        if (m.type === "SALIDA" || (m as any).type === "OUT") {
          movementsOutUsdDec = movementsOutUsdDec.plus(amt);
        }
      } else {
        if (m.type === "ENTRADA" || (m as any).type === "IN") {
          movementsInNioDec = movementsInNioDec.plus(amt);
        }
        if (m.type === "SALIDA" || (m as any).type === "OUT") {
          movementsOutNioDec = movementsOutNioDec.plus(amt);
        }
      }
    }

    const openingCashDec = new Prisma.Decimal(register.openingCash != null ? register.openingCash.toString() : 0);
    const expectedCashDec = openingCashDec.plus(totalCashDec).plus(movementsInNioDec).minus(movementsOutNioDec);
    const differenceDec = closingCashDec.minus(expectedCashDec);

    const expectedCashUsdDec = totalCashUsdDec.plus(movementsInUsdDec).minus(movementsOutUsdDec);
    const differenceUsdDec = closingCashUsdDec != null ? closingCashUsdDec.minus(expectedCashUsdDec) : null;

    const tolerance = new Prisma.Decimal(policies.cashDifferenceTolerance != null ? policies.cashDifferenceTolerance.toString() : 0);
    if (differenceDec.abs().greaterThan(tolerance) && !dto.notes && !dto.reason) {
      throw new (require('@nestjs/common').UnprocessableEntityException)({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'CASH_DIFFERENCE_NOTE_REQUIRED',
        message: {
          code: 'CASH_DIFFERENCE_NOTE_REQUIRED',
          message: 'La diferencia de caja supera la tolerancia. Debe incluir una nota.'
        }
      });
    }

    this.logger.log(
      `[close] id=${register.id} expectedCash=${expectedCashDec.toFixed(2)} closingCash=${closingCashDec.toFixed(2)} diff=${differenceDec.toFixed(2)}`
    );

    const finalNotes = dto.reason ? `[FORZADO: ${dto.reason}] ${dto.notes || ''}`.trim() : (dto.notes || register.notes);

    const businessBanks = await this.prisma.posBank.findMany({
      where: { businessId },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });

    const byMethodAndBank: any = this.calculateByMethodAndBank(register, dto.counted, businessBanks);
    byMethodAndBank.CASH = {
      expected: Number(expectedCashDec.toDecimalPlaces(2)),
      reported: Number(closingCashDec.toDecimalPlaces(2)),
      difference: Number(differenceDec.toDecimalPlaces(2)),
    };
    if (closingCashUsdDec != null || expectedCashUsdDec.greaterThan(0)) {
      byMethodAndBank.CASH_USD = {
        expected: Number(expectedCashUsdDec.toDecimalPlaces(2)),
        reported: closingCashUsdDec != null ? Number(closingCashUsdDec.toDecimalPlaces(2)) : null,
        difference: differenceUsdDec != null ? Number(differenceUsdDec.toDecimalPlaces(2)) : null,
      };
    }

    const closingBreakdownData: any = {
      ...byMethodAndBank,
      byMethodAndBank,
      denominations,
      countMode,
    };

    const updateResult = await this.prisma.cashRegister.updateMany({
      where: { id: register.id, status: 'OPEN' },
      data: {
        closedAt: new Date(),
        closingCash: closingCashDec,
        expectedCash: expectedCashDec,
        difference: differenceDec,
        closingCashUsd: closingCashUsdDec,
        expectedCashUsd: expectedCashUsdDec,
        differenceUsd: differenceUsdDec,
        totalSales: totalSalesDec,
        totalCash: totalCashDec,
        totalCashUsd: totalCashUsdDec,
        totalCard: totalCardDec,
        totalTransfer: totalTransferDec,
        closingBreakdown: closingBreakdownData,
        notes: finalNotes,
        status: "CLOSED",
      },
    });

    if (updateResult.count === 0) {
      throw new (require('@nestjs/common').ConflictException)({
        statusCode: 409,
        error: 'Conflict',
        code: 'SHIFT_ALREADY_CLOSED',
        message: {
          code: 'SHIFT_ALREADY_CLOSED',
          message: 'El turno ya se encuentra cerrado (posible doble click).'
        }
      });
    }

    const updated = await this.prisma.cashRegister.findUnique({
      where: { id: register.id },
      include: {
        cashier: { select: { id: true, name: true } },
        movements: true,
      },
    });

    await this.auditService.record({
      businessId,
      userId: cashierId || 'SYSTEM',
      userRole: userRole || 'SYSTEM',
      action: !differenceDec.isZero() ? 'CIERRE_TURNO_CON_DIFERENCIA' : (dto.reason ? 'CIERRE_TURNO_FORZADO' : 'CIERRE_TURNO'),
      entityType: 'CashRegister',
      entityId: register.id,
      reason: finalNotes,
    });

    // 213a: Barrido de vencimiento y corrección de reservas al cerrar caja
    try {
      const now = new Date();
      const expiredTickets = await this.prisma.presaleTicket.findMany({
        where: { businessId, status: 'PENDING', expiresAt: { lte: now } },
        select: { id: true },
      });
      for (const t of expiredTickets) {
        await this.prisma.$transaction(async (tx) => {
          const items = await tx.presaleTicketItem.findMany({
            where: { ticketId: t.id, removedAt: null },
          });
          for (const item of items) {
            if (item.productId && Number(item.reservedQty) > 0) {
              await tx.product.update({
                where: { id: item.productId },
                data: { reservedStock: { decrement: Number(item.reservedQty) } },
              });
            }
          }
          await tx.presaleTicket.update({
            where: { id: t.id },
            data: { status: 'EXPIRED' },
          });
        });
      }

      await this.prisma.$executeRaw`
        UPDATE pos_products p
        SET "reservedStock" = COALESCE((
          SELECT SUM(ti."reservedQty")
          FROM pos_presale_ticket_items ti
          JOIN pos_presale_tickets t ON t.id = ti."ticketId"
          WHERE ti."productId" = p.id
            AND t.status = 'PENDING'
            AND ti."removedAt" IS NULL
        ), 0)
        WHERE p."businessId" = ${businessId};
      `;
    } catch (err: any) {
      this.logger.warn(`[close] Error en barrido de preventa al cerrar turno: ${err.message}`);
    }

    const formatted = this.formatRegister(updated);
    return this.obfuscateRegister(formatted, businessId, userRole);
  }

  async addMovement(registerId: string | null | undefined, dto: CashMovementDto, businessId: string, userId: string, userRole: string) {
    let register;
    const isTargetingOther = registerId && registerId !== 'movements' && registerId !== 'movement' && registerId !== 'current';
    
    if (isTargetingOther) {
      if (userRole === 'CAJERO') {
         throw new ForbiddenException("Los cajeros solo pueden agregar movimientos a su turno actual.");
      }
      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId, businessId, status: "OPEN" },
      });
    } else {
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, cashierId: userId, status: "OPEN" },
        orderBy: { openedAt: "desc" },
      });
    }

    if (!register) throw new NotFoundException("No hay una caja abierta para registrar movimientos");

    let movementType: MovementType = MovementType.ENTRADA;
    if (dto.type === 'OUT' || dto.type === 'SALIDA') {
      movementType = MovementType.SALIDA;
    } else if (dto.type === 'IN' || dto.type === 'ENTRADA') {
      movementType = MovementType.ENTRADA;
    }

    const concept = (dto.concept || dto.reason || '').trim();
    if (!concept) {
      throw new BadRequestException({ statusCode: 422, code: 'REASON_REQUIRED', message: 'El motivo del movimiento es obligatorio' });
    }

    const amount = Number(dto.amount);
    if (amount <= 0) {
      throw new BadRequestException({ statusCode: 400, code: 'INVALID_AMOUNT', message: 'El monto debe ser mayor a cero' });
    }

    const currency = (dto.currency || 'NIO').toUpperCase();
    let exchangeRate = new Prisma.Decimal(1);
    const amountDec = new Prisma.Decimal(dto.amount.toString());
    let amountBaseDec = amountDec;

    if (currency === 'USD') {
      const activeRate = await this.exchangeRateService.getCurrentRate(businessId);
      exchangeRate = new Prisma.Decimal(activeRate.rate.toString());
      amountBaseDec = amountDec.times(exchangeRate).toDecimalPlaces(2);
    }

    this.logger.log(`[addMovement] register=${register.id} tipo=${movementType} monto=${amount} ${currency}`);
    const movement = await this.prisma.cashMovement.create({
      data: {
        businessId,
        cashRegisterId: register.id,
        userId,
        type: movementType,
        amount: amountDec,
        concept,
        currency,
        exchangeRate,
        amountBase: amountBaseDec,
      },
      include: {
        user: { select: { id: true, name: true } },
      },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: 'MOVIMIENTO_CAJA',
      entityType: 'CashMovement',
      entityId: movement.id,
      reason: `${movementType === 'ENTRADA' ? 'Entrada' : 'Salida'} por ${amount}: ${concept}`
    });

    return {
      ...movement,
      type: movement.type === 'SALIDA' ? 'OUT' : 'IN',
      rawType: movement.type,
      reason: movement.concept,
      amount: Number(movement.amount),
      currency: movement.currency,
      exchangeRate: Number(new Prisma.Decimal(movement.exchangeRate.toString()).toDecimalPlaces(4)),
      amountBase: Number(new Prisma.Decimal(movement.amountBase.toString()).toDecimalPlaces(2)),
    };
  }

  async getSummary(registerId: string, businessId: string, userRole?: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        sales: { include: { payments: true, returns: { include: { items: true } } } },
        movements: true,
      },
    });
    if (!register) throw new NotFoundException("Caja no encontrada");

    let totalSalesDec = new Prisma.Decimal(0);
    let totalCashDec = new Prisma.Decimal(0);
    let totalCashUsdDec = new Prisma.Decimal(0);
    let totalCashUsdBaseDec = new Prisma.Decimal(0);
    let totalCardDec = new Prisma.Decimal(0);
    let totalTransferDec = new Prisma.Decimal(0);

    for (const s of register.sales) {
      if (s.status !== 'CANCELLED' && s.status !== 'VOIDED') {
        const refundsTotal = (s.returns || []).reduce(
          (sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)),
          new Prisma.Decimal(0),
        );
        const netSale = Prisma.Decimal.max(0, new Prisma.Decimal(s.total != null ? s.total.toString() : 0).minus(refundsTotal));
        totalSalesDec = totalSalesDec.plus(netSale);

        const cardRefunds = (s.returns || [])
          .filter((r: any) => r.refundMethod === 'TARJETA')
          .reduce((sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)), new Prisma.Decimal(0));
        const transferRefunds = (s.returns || [])
          .filter((r: any) => r.refundMethod === 'TRANSFERENCIA')
          .reduce((sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)), new Prisma.Decimal(0));

        const breakdown = getSalePaymentBreakdown(s);
        totalCardDec = totalCardDec.plus(Prisma.Decimal.max(0, new Prisma.Decimal(breakdown.card).minus(cardRefunds)));
        totalTransferDec = totalTransferDec.plus(Prisma.Decimal.max(0, new Prisma.Decimal(breakdown.transfer).minus(transferRefunds)));
      }

      const breakdown = getSalePaymentBreakdown(s);
      totalCashDec = totalCashDec.plus(new Prisma.Decimal(breakdown.cashNio));
      totalCashUsdDec = totalCashUsdDec.plus(new Prisma.Decimal(breakdown.cashUsd));
      totalCashUsdBaseDec = totalCashUsdBaseDec.plus(new Prisma.Decimal(breakdown.cashUsdBase));
    }

    let movementsInNioDec = new Prisma.Decimal(0);
    let movementsOutNioDec = new Prisma.Decimal(0);
    let movementsInUsdDec = new Prisma.Decimal(0);
    let movementsOutUsdDec = new Prisma.Decimal(0);

    for (const m of register.movements) {
      const amt = new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0);
      const isUsd = (m.currency || '').toUpperCase() === 'USD';
      if (isUsd) {
        if (m.type === "ENTRADA" || (m as any).type === "IN") movementsInUsdDec = movementsInUsdDec.plus(amt);
        if (m.type === "SALIDA" || (m as any).type === "OUT") movementsOutUsdDec = movementsOutUsdDec.plus(amt);
      } else {
        if (m.type === "ENTRADA" || (m as any).type === "IN") movementsInNioDec = movementsInNioDec.plus(amt);
        if (m.type === "SALIDA" || (m as any).type === "OUT") movementsOutNioDec = movementsOutNioDec.plus(amt);
      }
    }

    const openingCashDec = new Prisma.Decimal(register.openingCash != null ? register.openingCash.toString() : 0);
    const currentCashDec = openingCashDec.plus(totalCashDec).plus(movementsInNioDec).minus(movementsOutNioDec);
    const currentCashUsdDec = totalCashUsdDec.plus(movementsInUsdDec).minus(movementsOutUsdDec);

    const formatted = this.formatRegister(register);

    const businessBanks = await this.prisma.posBank.findMany({
      where: { businessId },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });

    const byMethodAndBank: any = register.closingBreakdown || this.calculateByMethodAndBank(register, undefined, businessBanks);
    if (!byMethodAndBank.CASH) {
      byMethodAndBank.CASH = {
        expected: Number(currentCashDec.toDecimalPlaces(2)),
        reported: register.closingCash != null ? Number(new Prisma.Decimal(register.closingCash.toString()).toDecimalPlaces(2)) : null,
        difference: register.difference != null ? Number(new Prisma.Decimal(register.difference.toString()).toDecimalPlaces(2)) : null,
      };
    }

    const result = {
      register: formatted,
      summary: {
        totalSales: Number(totalSalesDec.toDecimalPlaces(2)),
        totalCash: Number(totalCashDec.toDecimalPlaces(2)),
        totalCashUsd: Number(totalCashUsdDec.toDecimalPlaces(2)),
        totalCard: Number(totalCardDec.toDecimalPlaces(2)),
        totalTransfer: Number(totalTransferDec.toDecimalPlaces(2)),
        movementsIn: Number(movementsInNioDec.toDecimalPlaces(2)),
        movementsOut: Number(movementsOutNioDec.toDecimalPlaces(2)),
        movementsInUsd: Number(movementsInUsdDec.toDecimalPlaces(2)),
        movementsOutUsd: Number(movementsOutUsdDec.toDecimalPlaces(2)),
        currentCash: Number(currentCashDec.toDecimalPlaces(2)),
        currentCashUsd: Number(currentCashUsdDec.toDecimalPlaces(2)),
        salesCount: register.sales.length,
        byMethodAndBank,
      },
    };

    const obfuscated = await this.obfuscateRegister(result, businessId, userRole);
    return obfuscated;
  }
  async drawerOpen(registerId: string | null | undefined, reason: string, businessId: string, userId: string, userRole: string) {
    let register;
    if (registerId && registerId !== 'current') {
      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId, businessId, status: "OPEN" },
      });
    } else {
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, cashierId: userId, status: "OPEN" },
        orderBy: { openedAt: "desc" },
      });
    }

    if (!register) throw new NotFoundException("No hay una caja abierta");

    const policies = await this.policiesService.get(businessId);
    if (!policies.noSaleDrawerOpenAllowed) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'DRAWER_OPEN_NOT_ALLOWED',
        message: 'La política del negocio no permite abrir el cajón sin una venta.'
      });
    }

    if (!reason) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'REASON_REQUIRED',
        message: 'Debe especificar un motivo para abrir el cajón.'
      });
    }

    // Registrar como movimiento especial DRAWER_OPEN
    const movement = await this.prisma.cashMovement.create({
      data: {
        businessId,
        cashRegisterId: register.id,
        userId,
        type: "DRAWER_OPEN",
        amount: 0,
        concept: `Apertura de cajón: ${reason}`,
      },
      include: {
        user: { select: { id: true, name: true } },
      },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: 'ABRIR_CAJON_SIN_VENTA',
      entityType: 'CashRegister',
      entityId: register.id,
      reason,
    });

    return { success: true, movement };
  }

  private calculateByMethodAndBank(
    register: any,
    counted?: CountedBreakdownDto,
    businessBanks?: any[],
  ) {
    const parsedCard = parseCountedMethod(counted?.CARD, counted?.cardByBank);
    const parsedTransfer = parseCountedMethod(counted?.TRANSFER, counted?.transferByBank);

    const cardExpectedMap = new Map<string, { bankId: string | null; bankName: string; amount: Prisma.Decimal }>();
    const transferExpectedMap = new Map<string, { bankId: string | null; bankName: string; amount: Prisma.Decimal }>();

    for (const s of (register.sales || [])) {
      if (s.status === 'CANCELLED' || s.status === 'VOIDED') continue;

      if (s.payments && Array.isArray(s.payments) && s.payments.length > 0) {
        for (const p of s.payments) {
          const method = (p.method || '').toUpperCase();
          const amt = new Prisma.Decimal(
            p.amountBase != null
              ? p.amountBase.toString()
              : (p.amount != null ? p.amount.toString() : 0),
          );
          const key = p.bankId || 'NO_BANK';
          const name = p.bankName || 'Sin banco';

          if (method === 'TARJETA') {
            const current = cardExpectedMap.get(key) || {
              bankId: p.bankId || null,
              bankName: name,
              amount: new Prisma.Decimal(0),
            };
            current.amount = current.amount.plus(amt);
            cardExpectedMap.set(key, current);
          } else if (method === 'TRANSFERENCIA') {
            const current = transferExpectedMap.get(key) || {
              bankId: p.bankId || null,
              bankName: name,
              amount: new Prisma.Decimal(0),
            };
            current.amount = current.amount.plus(amt);
            transferExpectedMap.set(key, current);
          }
        }
      } else {
        const method = (s.paymentMethod || '').toUpperCase();
        const amt = new Prisma.Decimal(s.total != null ? s.total.toString() : 0);
        if (method === 'TARJETA') {
          const current = cardExpectedMap.get('NO_BANK') || {
            bankId: null,
            bankName: 'Sin banco',
            amount: new Prisma.Decimal(0),
          };
          current.amount = current.amount.plus(amt);
          cardExpectedMap.set('NO_BANK', current);
        } else if (method === 'TRANSFERENCIA') {
          const current = transferExpectedMap.get('NO_BANK') || {
            bankId: null,
            bankName: 'Sin banco',
            amount: new Prisma.Decimal(0),
          };
          current.amount = current.amount.plus(amt);
          transferExpectedMap.set('NO_BANK', current);
        }
      }
    }

    const allBanks = [...(businessBanks || [])];
    const knownBankIds = new Set(allBanks.map((b) => b.id));

    for (const [, val] of cardExpectedMap.entries()) {
      if (val.bankId && !knownBankIds.has(val.bankId)) {
        allBanks.push({ id: val.bankId, name: val.bankName, order: 50 });
        knownBankIds.add(val.bankId);
      }
    }
    for (const [, val] of transferExpectedMap.entries()) {
      if (val.bankId && !knownBankIds.has(val.bankId)) {
        allBanks.push({ id: val.bankId, name: val.bankName, order: 50 });
        knownBankIds.add(val.bankId);
      }
    }

    allBanks.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));

    const cardByBankList: any[] = [];
    const transferByBankList: any[] = [];

    let totalCardExpected = new Prisma.Decimal(0);
    const totalCardReported: number | null =
      counted?.CARD !== undefined || counted?.cardByBank !== undefined ? parsedCard.total : null;

    for (const b of allBanks) {
      const exp = cardExpectedMap.get(b.id)?.amount || new Prisma.Decimal(0);
      totalCardExpected = totalCardExpected.plus(exp);
      const rep =
        parsedCard.byBank[b.id] !== undefined
          ? parsedCard.byBank[b.id]
          : (parsedCard.byBank[b.name] !== undefined ? parsedCard.byBank[b.name] : null);

      cardByBankList.push({
        bankId: b.id,
        bankName: b.name,
        expected: Number(exp.toDecimalPlaces(2)),
        reported: rep !== null ? Number(rep.toFixed(2)) : null,
        difference: rep !== null ? Number((rep - Number(exp)).toFixed(2)) : null,
      });
    }

    const noBankCardExp = cardExpectedMap.get('NO_BANK')?.amount || new Prisma.Decimal(0);
    totalCardExpected = totalCardExpected.plus(noBankCardExp);
    const noBankCardRep =
      parsedCard.byBank['NO_BANK'] !== undefined
        ? parsedCard.byBank['NO_BANK']
        : (parsedCard.byBank['Sin banco'] !== undefined ? parsedCard.byBank['Sin banco'] : null);

    cardByBankList.push({
      bankId: null,
      bankName: 'Sin banco',
      expected: Number(noBankCardExp.toDecimalPlaces(2)),
      reported: noBankCardRep !== null ? Number(noBankCardRep.toFixed(2)) : null,
      difference: noBankCardRep !== null ? Number((noBankCardRep - Number(noBankCardExp)).toFixed(2)) : null,
    });

    let totalTransferExpected = new Prisma.Decimal(0);
    const totalTransferReported: number | null =
      counted?.TRANSFER !== undefined || counted?.transferByBank !== undefined
        ? parsedTransfer.total
        : null;

    for (const b of allBanks) {
      const exp = transferExpectedMap.get(b.id)?.amount || new Prisma.Decimal(0);
      totalTransferExpected = totalTransferExpected.plus(exp);
      const rep =
        parsedTransfer.byBank[b.id] !== undefined
          ? parsedTransfer.byBank[b.id]
          : (parsedTransfer.byBank[b.name] !== undefined ? parsedTransfer.byBank[b.name] : null);

      transferByBankList.push({
        bankId: b.id,
        bankName: b.name,
        expected: Number(exp.toDecimalPlaces(2)),
        reported: rep !== null ? Number(rep.toFixed(2)) : null,
        difference: rep !== null ? Number((rep - Number(exp)).toFixed(2)) : null,
      });
    }

    const noBankTransferExp = transferExpectedMap.get('NO_BANK')?.amount || new Prisma.Decimal(0);
    totalTransferExpected = totalTransferExpected.plus(noBankTransferExp);
    const noBankTransferRep =
      parsedTransfer.byBank['NO_BANK'] !== undefined
        ? parsedTransfer.byBank['NO_BANK']
        : (parsedTransfer.byBank['Sin banco'] !== undefined ? parsedTransfer.byBank['Sin banco'] : null);

    transferByBankList.push({
      bankId: null,
      bankName: 'Sin banco',
      expected: Number(noBankTransferExp.toDecimalPlaces(2)),
      reported: noBankTransferRep !== null ? Number(noBankTransferRep.toFixed(2)) : null,
      difference:
        noBankTransferRep !== null ? Number((noBankTransferRep - Number(noBankTransferExp)).toFixed(2)) : null,
    });

    const expCardNum = Number(totalCardExpected.toDecimalPlaces(2));
    const expTransferNum = Number(totalTransferExpected.toDecimalPlaces(2));

    return {
      CARD: {
        expected: expCardNum,
        reported: totalCardReported,
        difference: totalCardReported !== null ? Number((totalCardReported - expCardNum).toFixed(2)) : null,
        byBank: cardByBankList,
      },
      TRANSFER: {
        expected: expTransferNum,
        reported: totalTransferReported,
        difference:
          totalTransferReported !== null ? Number((totalTransferReported - expTransferNum).toFixed(2)) : null,
        byBank: transferByBankList,
      },
    };
  }
}
