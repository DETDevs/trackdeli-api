import { Injectable, NotFoundException, BadRequestException, Logger, ForbiddenException, ConflictException, HttpException, HttpStatus } from "@nestjs/common";
import * as bcrypt from 'bcrypt';
import { PrismaService } from "../../../prisma/prisma.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto, CountedBreakdownDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";
import { CreateTipPayoutDto } from "./dto/create-tip-payout.dto";
import { MovementType, Prisma, UserRole } from "@prisma/client";
import { getSalePaymentBreakdown, parseCountedMethod } from "./pos-cash.utils";
import { PoliciesService } from '../policies/policies.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ALLOWED_DISCREPANCY_REASONS } from './constants/discrepancy-reasons.constant';
import { PushService } from '../push/push.service';
import { PushCategory } from '../push/push.constants';

@Injectable()
export class CashRegisterService {
  private readonly logger = new Logger(CashRegisterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policiesService: PoliciesService,
    private readonly auditService: AuditService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly pushService: PushService,
  ) {}

  /**
   * 263a - Suma propinas del turno sin mezclar con ventas ni IVA.
   * Las propinas en efectivo entran a expectedCash/expectedCashUsd (NIO/USD);
   * tipsSummary contabiliza únicamente propinas ACTIVE.
   */
  private computeTipsBreakdown(tips: any[] = []) {
    let cashNioDec = new Prisma.Decimal(0);
    let cashUsdDec = new Prisma.Decimal(0);
    let activeCashNioDec = new Prisma.Decimal(0);
    let activeCashUsdDec = new Prisma.Decimal(0);
    let activeCardDec = new Prisma.Decimal(0);
    let activeTransferDec = new Prisma.Decimal(0);
    let activeTotalBaseDec = new Prisma.Decimal(0);

    const byBankMap = new Map<
      string,
      { bankId: string | null; bankName: string; card: Prisma.Decimal; transfer: Prisma.Decimal; totalBase: Prisma.Decimal }
    >();

    const byWaiterMap = new Map<
      string,
      {
        waiterId: string | null;
        waiterName: string;
        cashNio: Prisma.Decimal;
        cashUsd: Prisma.Decimal;
        card: Prisma.Decimal;
        transfer: Prisma.Decimal;
        totalBase: Prisma.Decimal;
        paidBase: Prisma.Decimal;
        pendingBase: Prisma.Decimal;
      }
    >();

    for (const t of tips || []) {
      const amt = new Prisma.Decimal(t.amount != null ? t.amount.toString() : 0);
      const amtBase = new Prisma.Decimal(t.amountBase != null ? t.amountBase.toString() : amt);
      const curr = (t.currency || 'NIO').toUpperCase();
      const method = (t.paymentMethod || '').toUpperCase();

      if (method === 'EFECTIVO') {
        if (curr === 'USD') {
          cashUsdDec = cashUsdDec.plus(amt);
        } else {
          cashNioDec = cashNioDec.plus(amt);
        }
      }

      if (t.status === 'ACTIVE') {
        activeTotalBaseDec = activeTotalBaseDec.plus(amtBase);
        if (method === 'EFECTIVO') {
          if (curr === 'USD') {
            activeCashUsdDec = activeCashUsdDec.plus(amt);
          } else {
            activeCashNioDec = activeCashNioDec.plus(amt);
          }
        } else if (method === 'TARJETA') {
          activeCardDec = activeCardDec.plus(amtBase);
        } else if (method === 'TRANSFERENCIA') {
          activeTransferDec = activeTransferDec.plus(amtBase);
        }

        if (method === 'TARJETA' || method === 'TRANSFERENCIA') {
          const bKey = t.bankId || 'SIN_BANCO';
          let entry = byBankMap.get(bKey);
          if (!entry) {
            entry = {
              bankId: t.bankId || null,
              bankName: t.bankName || 'Sin banco',
              card: new Prisma.Decimal(0),
              transfer: new Prisma.Decimal(0),
              totalBase: new Prisma.Decimal(0),
            };
            byBankMap.set(bKey, entry);
          }
          if (method === 'TARJETA') entry.card = entry.card.plus(amtBase);
          if (method === 'TRANSFERENCIA') entry.transfer = entry.transfer.plus(amtBase);
          entry.totalBase = entry.totalBase.plus(amtBase);
        }

        // 319a: Desglose por mesero (con "Sin mesero" como fila con waiterId: null)
        const wKey = t.waiterId ? String(t.waiterId) : 'SIN_MESERO';
        let wEntry = byWaiterMap.get(wKey);
        if (!wEntry) {
          wEntry = {
            waiterId: t.waiterId || null,
            waiterName: t.waiterId ? (t.waiterName || 'Mesero') : 'Sin mesero',
            cashNio: new Prisma.Decimal(0),
            cashUsd: new Prisma.Decimal(0),
            card: new Prisma.Decimal(0),
            transfer: new Prisma.Decimal(0),
            totalBase: new Prisma.Decimal(0),
            paidBase: new Prisma.Decimal(0),
            pendingBase: new Prisma.Decimal(0),
          };
          byWaiterMap.set(wKey, wEntry);
        }
        if (method === 'EFECTIVO') {
          if (curr === 'USD') {
            wEntry.cashUsd = wEntry.cashUsd.plus(amt);
          } else {
            wEntry.cashNio = wEntry.cashNio.plus(amt);
          }
        } else if (method === 'TARJETA') {
          wEntry.card = wEntry.card.plus(amtBase);
        } else if (method === 'TRANSFERENCIA') {
          wEntry.transfer = wEntry.transfer.plus(amtBase);
        }
        wEntry.totalBase = wEntry.totalBase.plus(amtBase);
        if (t.paidAt || t.payoutId) {
          wEntry.paidBase = wEntry.paidBase.plus(amtBase);
        } else {
          wEntry.pendingBase = wEntry.pendingBase.plus(amtBase);
        }
      }
    }

    const tipsSummary = {
      cashNio: Number(activeCashNioDec.toDecimalPlaces(2)),
      cashUsd: Number(activeCashUsdDec.toDecimalPlaces(2)),
      card: Number(activeCardDec.toDecimalPlaces(2)),
      transfer: Number(activeTransferDec.toDecimalPlaces(2)),
      totalBase: Number(activeTotalBaseDec.toDecimalPlaces(2)),
      byBank: Array.from(byBankMap.values()).map((b) => ({
        bankId: b.bankId,
        bankName: b.bankName,
        card: Number(b.card.toDecimalPlaces(2)),
        transfer: Number(b.transfer.toDecimalPlaces(2)),
        totalBase: Number(b.totalBase.toDecimalPlaces(2)),
      })),
      byWaiter: Array.from(byWaiterMap.values())
        .map((w) => ({
          waiterId: w.waiterId,
          waiterName: w.waiterName,
          cashNio: Number(w.cashNio.toDecimalPlaces(2)),
          cashUsd: Number(w.cashUsd.toDecimalPlaces(2)),
          card: Number(w.card.toDecimalPlaces(2)),
          transfer: Number(w.transfer.toDecimalPlaces(2)),
          totalBase: Number(w.totalBase.toDecimalPlaces(2)),
          paidBase: Number(w.paidBase.toDecimalPlaces(2)),
          pendingBase: Number(w.pendingBase.toDecimalPlaces(2)),
        }))
        .sort((a, b) => b.totalBase - a.totalBase),
    };

    return {
      allCashNioDec: cashNioDec,
      allCashUsdDec: cashUsdDec,
      tipsSummary,
    };
  }

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

    const tipsCalc = this.computeTipsBreakdown(register.tips || []);
    const liveExpectedCash = decInitialAmount.plus(decCalculatedCashNio).plus(tipsCalc.allCashNioDec).plus(decMovementsInNio).minus(decMovementsOutNio);
    const expectedCashDec = register.expectedCash != null ? new Prisma.Decimal(register.expectedCash.toString()) : liveExpectedCash;

    const actualAmountDec = register.closingCash != null 
      ? new Prisma.Decimal(register.closingCash.toString()) 
      : (register.actualAmount != null ? new Prisma.Decimal(register.actualAmount.toString()) : null);

    const differenceDec = register.difference != null 
      ? new Prisma.Decimal(register.difference.toString()) 
      : (actualAmountDec != null ? actualAmountDec.minus(expectedCashDec) : null);

    const liveExpectedCashUsd = decCalculatedCashUsd.plus(tipsCalc.allCashUsdDec).plus(decMovementsInUsd).minus(decMovementsOutUsd);
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
      tipsSummary: (register.tips && register.tips.length > 0)
        ? tipsCalc.tipsSummary
        : (closingBreakdown.tipsSummary
            ? { byWaiter: [], ...closingBreakdown.tipsSummary }
            : tipsCalc.tipsSummary),
      recountAttempts: register.recountAttempts ?? 0,
      discrepancyReason: register.discrepancyReason ?? null,
      discrepancyNote: register.discrepancyNote ?? null,
      discrepancyAuthorizedById: register.discrepancyAuthorizedById ?? null,
      discrepancyAuthorizedAt: register.discrepancyAuthorizedAt ?? null,
      discrepancyAuthorizer: register.discrepancyAuthorizer ? {
        id: register.discrepancyAuthorizer.id,
        name: register.discrepancyAuthorizer.name,
        role: register.discrepancyAuthorizer.role,
      } : null,
      deviceId: register.deviceId ?? null,
      deviceName: register.deviceName ?? null,
      registerSource: register.registerSource || 'DESKTOP',
    };
  }

  private isWebPlatform(clientPlatform?: string | null): boolean {
    if (!clientPlatform) return false;
    return clientPlatform.trim().toLowerCase().startsWith('web');
  }

  private resolveRegisterSource(clientPlatform?: string | null, deviceCategory?: string | null): 'WEB' | 'DESKTOP' | 'MOBILE' {
    const plat = (clientPlatform || '').trim().toLowerCase();
    if (plat.startsWith('web')) return 'WEB';
    if (plat.startsWith('mobile')) return 'MOBILE';
    const cat = (deviceCategory || '').trim().toUpperCase();
    if (cat === 'WEB') return 'WEB';
    if (cat === 'MOBILE') return 'MOBILE';
    return 'DESKTOP';
  }

  private buildWebRegisterName(cashierName?: string | null): string {
    const cleanName = (cashierName || '').trim() || 'Cajero';
    return `Caja web · ${cleanName}`;
  }

  async obfuscateRegister(
    registerData: any,
    businessId: string,
    userRole?: string,
    userId?: string,
    deviceId?: string,
  ) {
    const isCashierOrSeller = userRole === UserRole.CAJERO || userRole === UserRole.VENDEDOR;
    if (!isCashierOrSeller) return registerData;
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
          expected: null,
          difference: null,
        };
        if (Array.isArray(mVal.byBank)) {
          methodObj.byBank = mVal.byBank.map((b: any) => ({
            bankId: b.bankId,
            bankName: b.bankName,
            reported: b.reported !== undefined ? b.reported : null,
            expected: null,
            difference: null,
          }));
        }
        obfuscated[method] = methodObj;
      }
      return obfuscated;
    };

    const whitelistBlindRegister = (reg: any) => {
      if (!reg) return null;
      const isClosed = reg.status === 'CLOSED' || !!reg.closedAt;

      // 235a (ajuste fail-closed): sin userId identificado, el fondo inicial NO se muestra.
      // Con userId, solo en turnos propios o de la computadora del cajero.
      const isAllowedToSeeOpening =
        !!userId &&
        (reg.cashierId === userId ||
          reg.openedById === userId ||
          (!!deviceId && !!reg.deviceId && reg.deviceId === deviceId));

      const rawOpeningCash =
        reg.openingCash != null
          ? Number(reg.openingCash)
          : reg.initialAmount != null
          ? Number(reg.initialAmount)
          : 0;

      const openingCash = isAllowedToSeeOpening ? rawOpeningCash : null;
      const initialAmount = isAllowedToSeeOpening ? rawOpeningCash : null;

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
        recountAttempts: reg.recountAttempts ?? 0,
        discrepancyReason: reg.discrepancyReason ?? null,
        discrepancyNote: reg.discrepancyNote ?? null,
        discrepancyAuthorizedById: reg.discrepancyAuthorizedById ?? null,
        discrepancyAuthorizedAt: reg.discrepancyAuthorizedAt ?? null,
        discrepancyAuthorizer: reg.discrepancyAuthorizer ?? null,
        deviceId: reg.deviceId ?? null,
        deviceName: reg.deviceName ?? null,
        registerSource: reg.registerSource || 'DESKTOP',
        byMethodAndBank: obfuscateByMethodAndBank(reg.byMethodAndBank),

        // 235a: Fondo inicial visible con su valor real para el cajero en sus turnos
        openingCash,
        initialAmount,

        // Valores sensibles devueltos EXPLICITAMENTE como null (NUNCA 0)
        cashSales: null,
        expectedCash: null,
        expectedAmount: null,
        difference: null,
        expectedCashUsd: null,
        differenceUsd: null,
        totalSales: null,
        totalCash: null,
        totalCashUsd: null,
        totalCard: null,
        totalTransfer: null,
        movementsIn: null,
        movementsOut: null,
        movementsInUsd: null,
        movementsOutUsd: null,
        salesByChannel: null,
        tipsSummary: null,
      };
    };

    if (registerData.register && registerData.summary) {
      return {
        register: whitelistBlindRegister(registerData.register),
        summary: {
          salesCount: registerData.summary.salesCount ?? 0,
          byMethodAndBank: obfuscateByMethodAndBank(registerData.summary.byMethodAndBank),
          totalSales: null,
          totalCash: null,
          totalCashUsd: null,
          totalCard: null,
          totalTransfer: null,
          movementsIn: null,
          movementsOut: null,
          movementsInUsd: null,
          movementsOutUsd: null,
          tipsSummary: null,
        },
      };
    }

    return whitelistBlindRegister(registerData);
  }

  async getCurrent(
    businessId: string,
    cashierId?: string,
    userRole?: string,
    deviceId?: string,
    clientPlatform?: string,
  ) {
    const cleanDeviceId = deviceId?.trim() || null;
    const isWeb = this.isWebPlatform(clientPlatform);
    let register = null;

    const fullInclude = {
      cashier: { select: { id: true, name: true } },
      discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
      movements: true,
      tips: true,
      sales: {
        orderBy: { createdAt: "desc" as const },
        include: { payments: true, returns: { include: { items: true } } },
      },
      _count: { select: { sales: true } },
    };

    if (isWeb) {
      if (cashierId) {
        register = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            cashierId,
            status: "OPEN",
            registerSource: "WEB",
          },
          include: fullInclude,
          orderBy: { openedAt: "desc" },
        });

        // Si el usuario tiene turno web abierto y entra desde otro navegador (otro deviceId), re-asociar
        if (register && cleanDeviceId && register.deviceId !== cleanDeviceId) {
          const newDeviceName = this.buildWebRegisterName(register.cashier?.name);
          register = await this.prisma.cashRegister.update({
            where: { id: register.id },
            data: {
              deviceId: cleanDeviceId,
              deviceName: newDeviceName,
            },
            include: fullInclude,
          });
        }
      }
    } else if (cleanDeviceId) {
      register = await this.prisma.cashRegister.findFirst({
        where: {
          businessId,
          deviceId: cleanDeviceId,
          status: "OPEN",
          registerSource: { not: "WEB" },
        },
        include: fullInclude,
        orderBy: { openedAt: "desc" },
      });

      // Adopción en getCurrent: si esa computadora no tiene turno pero el usuario tiene uno abierto con deviceId nulo (no web)
      if (!register && cashierId) {
        const legacyShift = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            cashierId,
            deviceId: null,
            status: "OPEN",
            registerSource: { not: "WEB" },
          },
          orderBy: { openedAt: "desc" },
        });
        if (legacyShift) {
          const posDev = await this.prisma.posDevice.findFirst({
            where: { businessId, deviceId: cleanDeviceId },
            select: { name: true },
          });
          register = await this.prisma.cashRegister.update({
            where: { id: legacyShift.id },
            data: {
              deviceId: cleanDeviceId,
              deviceName: posDev?.name || legacyShift.deviceName,
            },
            include: fullInclude,
          });
        }
      }
    } else if (cashierId) {
      // Sin X-Device-Id ni plataforma web explícita: busca por usuario
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, cashierId, status: "OPEN" },
        include: fullInclude,
        orderBy: { openedAt: "desc" },
      });
    }

    if (!register) return null;
    return this.obfuscateRegister(this.formatRegister(register), businessId, userRole, cashierId, cleanDeviceId);
  }

  async findAll(businessId: string, userRole?: string, userId?: string) {
    const registers = await this.prisma.cashRegister.findMany({
      where: { businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
        movements: true,
        tips: true,
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
    return Promise.all(formatted.map(f => this.obfuscateRegister(f, businessId, userRole, userId)));
  }

  async open(
    dto: OpenCashRegisterDto,
    businessId: string,
    cashierId: string,
    deviceId?: string,
    deviceName?: string,
    userRole: string = UserRole.CAJERO,
    clientPlatform?: string,
  ) {
    const cleanDeviceId = deviceId?.trim() || null;
    let cleanDeviceName = deviceName?.trim() || null;
    const isWeb = this.isWebPlatform(clientPlatform);
    const openingCash = Number(dto.openingCash ?? dto.initialAmount ?? dto.amount ?? 0);

    if (isWeb) {
      const createdWeb = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${businessId}:web_shift:${cashierId}`}))`;

        const existingWebOpen = await tx.cashRegister.findFirst({
          where: {
            businessId,
            cashierId,
            status: "OPEN",
            registerSource: "WEB",
          },
          orderBy: { openedAt: "desc" },
        });

        if (existingWebOpen) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'WEB_REGISTER_ALREADY_OPEN',
            message: 'Ya tenés una caja web abierta. Seguí con esa o cerrala antes de abrir otra.',
            error: 'Bad Request',
          });
        }

        const cashierUser = await tx.user.findUnique({
          where: { id: cashierId },
          select: { name: true },
        });
        const webDeviceName = this.buildWebRegisterName(cashierUser?.name);

        this.logger.log(
          `[open][WEB] cashier=${cashierId} businessId=${businessId} deviceId=${cleanDeviceId} deviceName="${webDeviceName}" openingCash=${openingCash}`,
        );

        return tx.cashRegister.create({
          data: {
            businessId,
            cashierId,
            openingCash,
            notes: dto.notes,
            status: "OPEN",
            deviceId: cleanDeviceId,
            deviceName: webDeviceName,
            registerSource: "WEB",
          },
          include: {
            cashier: { select: { id: true, name: true } },
            discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
            movements: true,
            tips: true,
            sales: { include: { payments: true, returns: { include: { items: true } } } },
          },
        });
      });

      return this.obfuscateRegister(
        this.formatRegister(createdWeb),
        businessId,
        userRole,
        cashierId,
        cleanDeviceId ?? undefined,
      );
    }

    let deviceCategory: string | null = null;
    if (cleanDeviceId) {
      const posDev = await this.prisma.posDevice.findFirst({
        where: { businessId, deviceId: cleanDeviceId },
        select: { name: true, category: true },
      });
      deviceCategory = posDev?.category || null;
      if (!cleanDeviceName) {
        cleanDeviceName = posDev?.name || null;
      }

      // Validar si ese equipo físico ya tiene turno abierto
      const openOnDevice = await this.prisma.cashRegister.findFirst({
        where: {
          businessId,
          deviceId: cleanDeviceId,
          status: "OPEN",
          registerSource: { not: "WEB" },
        },
      });
      if (openOnDevice) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'DEVICE_REGISTER_ALREADY_OPEN',
          message: 'Esta computadora ya tiene un turno de caja abierto.',
          error: 'Bad Request',
        });
      }

      // Adopción de turnos viejos: si no tiene turno y existe uno abierto del mismo usuario con deviceId nulo (no web)
      const legacyShift = await this.prisma.cashRegister.findFirst({
        where: {
          businessId,
          cashierId,
          deviceId: null,
          status: "OPEN",
          registerSource: { not: "WEB" },
        },
        include: {
          cashier: { select: { id: true, name: true } },
          discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
          movements: true,
          tips: true,
          sales: { include: { payments: true, returns: { include: { items: true } } } },
        },
        orderBy: { openedAt: "desc" },
      });

      if (legacyShift) {
        const adopted = await this.prisma.cashRegister.update({
          where: { id: legacyShift.id },
          data: {
            deviceId: cleanDeviceId,
            deviceName: cleanDeviceName || legacyShift.deviceName,
          },
          include: {
            cashier: { select: { id: true, name: true } },
            discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
            movements: true,
            tips: true,
            sales: { include: { payments: true, returns: { include: { items: true } } } },
          },
        });
        return this.obfuscateRegister(this.formatRegister(adopted), businessId, userRole, cashierId, cleanDeviceId ?? undefined);
      }
    } else {
      // Sin X-Device-Id: validación por usuario
      const existing = await this.prisma.cashRegister.findFirst({
        where: { businessId, cashierId, status: "OPEN" },
      });
      if (existing) {
        throw new BadRequestException("Ya tienes una caja abierta. Ciérrala antes de abrir una nueva.");
      }
    }

    const registerSource = this.resolveRegisterSource(clientPlatform, deviceCategory);
    this.logger.log(`[open] cashier=${cashierId} businessId=${businessId} deviceId=${cleanDeviceId} source=${registerSource} openingCash=${openingCash}`);
    const created = await this.prisma.cashRegister.create({
      data: {
        businessId,
        cashierId,
        openingCash,
        notes: dto.notes,
        status: "OPEN",
        deviceId: cleanDeviceId,
        deviceName: cleanDeviceName,
        registerSource,
      },
      include: {
        cashier: { select: { id: true, name: true } },
        discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
        movements: true,
        tips: true,
        sales: { include: { payments: true, returns: { include: { items: true } } } },
      },
    });
    return this.obfuscateRegister(this.formatRegister(created), businessId, userRole, cashierId, cleanDeviceId ?? undefined);
  }

  async close(
    registerId: string | null | undefined,
    dto: CloseCashRegisterDto,
    businessId: string,
    cashierId?: string,
    userRole?: string,
    deviceId?: string,
    clientPlatform?: string,
  ) {
    const cleanDeviceId = (deviceId || dto.deviceId || '').trim() || null;
    const isWeb = this.isWebPlatform(clientPlatform);
    const isExplicitTarget = Boolean(
      registerId && registerId !== 'close' && registerId !== 'current',
    );
    let register;

    const closeInclude = {
      cashier: { select: { id: true, name: true } },
      discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
      sales: { include: { payments: true, returns: { include: { items: true } } } },
      movements: true,
      tips: true,
    };

    if (isExplicitTarget) {
      if (isWeb) {
        if (userRole !== UserRole.ENCARGADO && userRole !== UserRole.SUPERADMIN) {
          throw new ForbiddenException('Solo el encargado puede cerrar un turno desde esta ruta');
        }

        const hasExplicitCash =
          (dto.closingCash !== undefined && dto.closingCash !== null) ||
          (dto.actualAmount !== undefined && dto.actualAmount !== null) ||
          (dto.amount !== undefined && dto.amount !== null) ||
          typeof (dto as any).counted === 'number' ||
          (dto.counted && dto.counted.CASH !== undefined && dto.counted.CASH !== null) ||
          Boolean(
            (dto.denominations && dto.denominations.length > 0) ||
              (dto.counted?.denominations && dto.counted.denominations.length > 0),
          );

        if (!hasExplicitCash) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'CLOSING_CASH_REQUIRED',
            message: 'Debés ingresar el efectivo contado para cerrar el turno.',
            error: 'Bad Request',
          });
        }

        const rawReason = (dto.reason || dto.discrepancyNote || dto.notes || '').trim();
        if (rawReason.length < 5) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'REASON_REQUIRED',
            message: 'El motivo es obligatorio y debe tener al menos 5 caracteres.',
            error: 'Bad Request',
          });
        }
        if (!dto.reason) {
          dto.reason = rawReason;
        }
      }

      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId!, businessId, status: "OPEN" },
        include: closeInclude,
      });
    } else if (isWeb) {
      if (cashierId) {
        register = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            cashierId,
            status: "OPEN",
            registerSource: "WEB",
          },
          include: closeInclude,
          orderBy: { openedAt: "desc" },
        });

        if (register && cleanDeviceId && register.deviceId !== cleanDeviceId) {
          const newDeviceName = this.buildWebRegisterName(register.cashier?.name);
          register = await this.prisma.cashRegister.update({
            where: { id: register.id },
            data: {
              deviceId: cleanDeviceId,
              deviceName: newDeviceName,
            },
            include: closeInclude,
          });
        }
      }
    } else {
      if (cleanDeviceId) {
        register = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            deviceId: cleanDeviceId,
            status: "OPEN",
            registerSource: { not: "WEB" },
          },
          include: closeInclude,
          orderBy: { openedAt: "desc" },
        });

        // Adopción si hay turno de este usuario con deviceId null (no web)
        if (!register && cashierId) {
          register = await this.prisma.cashRegister.findFirst({
            where: {
              businessId,
              cashierId,
              deviceId: null,
              status: "OPEN",
              registerSource: { not: "WEB" },
            },
            include: closeInclude,
            orderBy: { openedAt: "desc" },
          });
        }
      } else {
        register = await this.prisma.cashRegister.findFirst({
          where: { businessId, ...(cashierId ? { cashierId } : {}), status: "OPEN" },
          include: closeInclude,
          orderBy: { openedAt: "desc" },
        });
      }
    }

    if (!register) throw new NotFoundException("Caja no encontrada o ya cerrada");

    if (userRole === UserRole.CAJERO) {
      if (register.cashierId !== cashierId) {
        throw new ForbiddenException(
          dto.reason
            ? 'Solo el encargado puede forzar el cierre de turno de otro usuario'
            : 'Solo el encargado puede cerrar el turno de otro usuario',
        );
      }
      if (!isWeb && cleanDeviceId && register.deviceId && register.deviceId !== cleanDeviceId) {
        throw new ForbiddenException('Los cajeros solo pueden cerrar el turno de su propia computadora');
      }
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

    const closeTipsCalc = this.computeTipsBreakdown((register as any).tips || []);
    const openingCashDec = new Prisma.Decimal(register.openingCash != null ? register.openingCash.toString() : 0);
    const expectedCashDec = openingCashDec.plus(totalCashDec).plus(closeTipsCalc.allCashNioDec).plus(movementsInNioDec).minus(movementsOutNioDec);
    const differenceDec = closingCashDec.minus(expectedCashDec);

    const expectedCashUsdDec = totalCashUsdDec.plus(closeTipsCalc.allCashUsdDec).plus(movementsInUsdDec).minus(movementsOutUsdDec);
    const differenceUsdDec = closingCashUsdDec != null ? closingCashUsdDec.minus(expectedCashUsdDec) : null;

    const discrepancyPolicy = (policies as any).cashCloseDiscrepancyPolicy || 'AUTORIZACION';
    const tolerance = new Prisma.Decimal(
      (policies as any).cashCloseTolerance != null
        ? (policies as any).cashCloseTolerance.toString()
        : (policies.cashDifferenceTolerance != null ? policies.cashDifferenceTolerance.toString() : 0)
    );
    const maxRecounts = (policies as any).cashCloseMaxRecounts != null ? (policies as any).cashCloseMaxRecounts : 1;

    const isAboveTolerance = differenceDec.abs().greaterThan(tolerance);
    const isCashierOrSeller = userRole === UserRole.CAJERO || userRole === UserRole.VENDEDOR;
    const isSupervisor = userRole === UserRole.ENCARGADO || userRole === UserRole.SUPERADMIN;

    let authorizedById: string | null = null;
    let authorizedAt: Date | null = null;
    let currentRecounts = register.recountAttempts ?? 0;

    if (dto.discrepancyReason) {
      if (!ALLOWED_DISCREPANCY_REASONS.includes(dto.discrepancyReason as any)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'DISCREPANCY_REASON_INVALID',
          message: `Motivo de descuadre no válido. Debe ser uno de: ${ALLOWED_DISCREPANCY_REASONS.join(', ')}`,
        });
      }
      if (dto.discrepancyReason === 'OTRO') {
        const effectiveNote = (dto.discrepancyNote || dto.notes || '').trim();
        if (effectiveNote.length < 10) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'DISCREPANCY_NOTE_TOO_SHORT',
            message: 'Para el motivo OTRO, la nota explicativa debe tener al menos 10 caracteres.',
          });
        }
      }
    }

    if (isAboveTolerance && discrepancyPolicy === 'AUTORIZACION' && !dto.reason) {
      if (isCashierOrSeller) {
        if (currentRecounts < maxRecounts) {
          await this.prisma.cashRegister.update({
            where: { id: register.id },
            data: { recountAttempts: { increment: 1 } },
          });
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'CASH_CLOSE_COUNT_MISMATCH',
            message: 'El conteo no coincide con lo registrado. Revisa el efectivo y vuelve a contar.',
          });
        }

        // Reconteos agotados -> Exige motivo, nota y autorización por PIN de ENCARGADO o SUPERADMIN
        const hasReason = Boolean(dto.discrepancyReason && dto.discrepancyReason.trim());
        const hasNote = Boolean((dto.discrepancyNote && dto.discrepancyNote.trim()) || (dto.notes && dto.notes.trim()));
        const hasPin = Boolean(dto.authorizerPin && dto.authorizerPin.trim());

        if (!hasReason || !hasNote || !hasPin) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'CASH_CLOSE_AUTH_REQUIRED',
            message: 'Se requiere autorización del encargado para cerrar la caja con descuadre.',
          });
        }

        const cleanPin = dto.authorizerPin!.trim();

        // 230a ajuste: Límite de intentos de PIN: máximo 5 fallidos en 15 minutos por negocio y usuario
        const PIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
        const MAX_PIN_FAILURES = 5;
        const windowStart = new Date(Date.now() - PIN_LOCK_WINDOW_MS);

        const failedAttemptsCount = await this.prisma.posAuditLog.count({
          where: {
            businessId,
            userId: cashierId,
            action: 'CIERRE_PIN_INVALIDO',
            createdAt: { gte: windowStart },
          },
        });

        if (failedAttemptsCount >= MAX_PIN_FAILURES) {
          await this.auditService.record({
            businessId,
            userId: cashierId || 'UNKNOWN',
            userRole: userRole || 'UNKNOWN',
            action: 'CIERRE_PIN_BLOQUEADO',
            entityType: 'CashRegister',
            entityId: register.id,
            reason: 'Intento de cierre de caja bloqueado por exceder el límite de intentos de PIN',
          });
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              error: 'Too Many Requests',
              code: 'CASH_CLOSE_PIN_LOCKED',
              message: 'Demasiados intentos con el PIN. Espera unos minutos o pide al encargado que cierre el turno.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        // 1. Encargados directos de esta sucursal (y superadmins)
        const directAuthorizers = await this.prisma.user.findMany({
          where: {
            businessId,
            isActive: true,
            role: { in: [UserRole.ENCARGADO, UserRole.SUPERADMIN] },
            pinHash: { not: null },
            ...(dto.authorizerEmail ? { email: dto.authorizerEmail.trim().toLowerCase() } : {}),
          },
          select: { id: true, name: true, role: true, pinHash: true, email: true },
        });

        // 2. Encargados con acceso multi-sucursal a esta sucursal (240a)
        const currentBiz = await this.prisma.business.findUnique({
          where: { id: businessId },
          select: { organizationId: true },
        });

        let multiBranchAuthorizers: any[] = [];
        if (currentBiz?.organizationId) {
          const accesses = await this.prisma.userBusinessAccess.findMany({
            where: {
              businessId,
              user: {
                isActive: true,
                role: UserRole.ENCARGADO,
                pinHash: { not: null },
                business: { organizationId: currentBiz.organizationId },
                ...(dto.authorizerEmail ? { email: dto.authorizerEmail.trim().toLowerCase() } : {}),
              },
            },
            include: {
              user: {
                select: { id: true, name: true, role: true, pinHash: true, email: true },
              },
            },
          });
          multiBranchAuthorizers = accesses.map((a) => a.user);
        }

        const authorizers = [...directAuthorizers, ...multiBranchAuthorizers];

        let matchedAuthorizer: any = null;
        for (const auth of authorizers) {
          if (auth.pinHash && (await bcrypt.compare(cleanPin, auth.pinHash))) {
            matchedAuthorizer = auth;
            break;
          }
        }

        if (!matchedAuthorizer) {
          await this.auditService.record({
            businessId,
            userId: cashierId || 'UNKNOWN',
            userRole: userRole || 'UNKNOWN',
            action: 'CIERRE_PIN_INVALIDO',
            entityType: 'CashRegister',
            entityId: register.id,
            reason: 'PIN de autorización incorrecto o usuario sin permisos al intentar cerrar caja con descuadre',
          });
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'CASH_CLOSE_AUTH_REQUIRED',
            message: 'PIN de autorización inválido o usuario no autorizado.',
          });
        }

        authorizedById = matchedAuthorizer.id;
        authorizedAt = new Date();
      } else if (isSupervisor) {
        const hasReason = Boolean(dto.discrepancyReason && dto.discrepancyReason.trim()) || Boolean(dto.reason && dto.reason.trim());
        const hasNote = Boolean((dto.discrepancyNote && dto.discrepancyNote.trim()) || (dto.notes && dto.notes.trim()));
        if (!hasReason || !hasNote) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'CASH_DIFFERENCE_NOTE_REQUIRED',
            message: 'Se requiere indicar motivo y nota explicativa del descuadre.',
          });
        }
        authorizedById = cashierId || null;
        authorizedAt = new Date();
      }
    } else if (isAboveTolerance) {
      if (!dto.notes && !dto.reason && !dto.discrepancyNote) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'CASH_DIFFERENCE_NOTE_REQUIRED',
          message: 'La diferencia de caja supera la tolerancia. Debe incluir una nota.',
        });
      }
      if (isSupervisor) {
        authorizedById = cashierId || null;
        authorizedAt = new Date();
      }
    }

    this.logger.log(
      `[close] id=${register.id} expectedCash=${expectedCashDec.toFixed(2)} closingCash=${closingCashDec.toFixed(2)} diff=${differenceDec.toFixed(2)}`
    );

    const finalReason = isAboveTolerance ? (dto.discrepancyReason || dto.reason || 'DESCUADRE') : null;
    const finalDiscrepancyNote = isAboveTolerance ? (dto.discrepancyNote || dto.notes || null) : null;
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
      tipsSummary: closeTipsCalc.tipsSummary,
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
        recountAttempts: currentRecounts,
        discrepancyReason: finalReason,
        discrepancyNote: finalDiscrepancyNote,
        discrepancyAuthorizedById: authorizedById,
        discrepancyAuthorizedAt: authorizedAt,
      },
    });

    if (updateResult.count === 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SHIFT_ALREADY_CLOSED',
        message: 'El turno ya se encuentra cerrado (posible doble click).'
      });
    }

    const updated = await this.prisma.cashRegister.findUnique({
      where: { id: register.id },
      include: {
        cashier: { select: { id: true, name: true } },
        discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
        movements: true,
        tips: true,
      },
    });

    await this.auditService.record({
      businessId,
      userId: cashierId || 'SYSTEM',
      userRole: userRole || 'SYSTEM',
      action: isAboveTolerance ? 'CIERRE_TURNO_CON_DESCUADRE' : (dto.reason ? 'CIERRE_TURNO_FORZADO' : 'CIERRE_TURNO'),
      entityType: 'CashRegister',
      entityId: register.id,
      approvedById: authorizedById || (isExplicitTarget && cashierId ? cashierId : undefined),
      reason: finalNotes,
      before: isAboveTolerance ? {
        expectedCash: Number(expectedCashDec.toDecimalPlaces(2)),
        closingCash: Number(closingCashDec.toDecimalPlaces(2)),
        difference: Number(differenceDec.toDecimalPlaces(2)),
        recountAttempts: currentRecounts,
        reason: finalReason,
        note: finalDiscrepancyNote,
      } : undefined,
      after: {
        closedByUserId: cashierId || null,
        registerCashierId: register.cashierId,
        registerSource: register.registerSource || 'DESKTOP',
        expectedCash: Number(expectedCashDec.toDecimalPlaces(2)),
        closingCash: Number(closingCashDec.toDecimalPlaces(2)),
        difference: Number(differenceDec.toDecimalPlaces(2)),
      },
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

    // 300b (#3 CAJA_DESCUADRE): efecto secundario después del commit, nunca bloquea ni rompe el cierre
    if (isAboveTolerance) {
      try {
        const absDiff = Math.abs(Number(differenceDec.toDecimalPlaces(2)));
        const diffFormatted = absDiff.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const cashierName = updated?.cashier?.name || 'un cajero';
        void Promise.resolve(
          this.pushService.sendFireAndForget({
            businessId,
            roles: [UserRole.ENCARGADO, UserRole.SUPERADMIN],
            category: PushCategory.CAJA_DESCUADRE,
            title: 'Descuadre en cierre de caja',
            body: `Cierre con diferencia de C$ ${diffFormatted} en la caja de ${cashierName}`,
            data: {
              category: PushCategory.CAJA_DESCUADRE,
              screen: 'cash_register_detail',
              id: register.id,
            },
            dedupeKey: `caja_descuadre:${register.id}`,
          }),
        ).catch(() => {});
      } catch (pushErr: any) {
        this.logger.warn(`[close] Error disparando push CAJA_DESCUADRE: ${pushErr?.message || 'desconocido'}`);
      }
    }

    const formatted = this.formatRegister(updated);
    return this.obfuscateRegister(formatted, businessId, userRole, cashierId, cleanDeviceId);
  }

  async addMovement(registerId: string | null | undefined, dto: CashMovementDto, businessId: string, userId: string, userRole: string, deviceId?: string, clientPlatform?: string) {
    let register;
    const isTargetingOther = registerId && registerId !== 'movements' && registerId !== 'movement' && registerId !== 'current';
    const cleanDeviceId = deviceId?.trim() || null;
    const isWeb = this.isWebPlatform(clientPlatform);

    if (isTargetingOther) {
      if (userRole === 'CAJERO') {
        throw new ForbiddenException("Los cajeros solo pueden agregar movimientos a su turno actual.");
      }
      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId, businessId, status: "OPEN" },
        include: { cashier: { select: { id: true, name: true } } },
      });
      if (
        isWeb &&
        register &&
        register.cashierId === userId &&
        register.registerSource === 'WEB' &&
        cleanDeviceId &&
        register.deviceId !== cleanDeviceId
      ) {
        register = await this.prisma.cashRegister.update({
          where: { id: register.id },
          data: {
            deviceId: cleanDeviceId,
            deviceName: this.buildWebRegisterName(register.cashier?.name),
          },
          include: { cashier: { select: { id: true, name: true } } },
        });
      }
    } else if (isWeb) {
      register = await this.prisma.cashRegister.findFirst({
        where: {
          businessId,
          cashierId: userId,
          status: "OPEN",
          registerSource: "WEB",
        },
        include: { cashier: { select: { id: true, name: true } } },
        orderBy: { openedAt: "desc" },
      });
      if (register && cleanDeviceId && register.deviceId !== cleanDeviceId) {
        register = await this.prisma.cashRegister.update({
          where: { id: register.id },
          data: {
            deviceId: cleanDeviceId,
            deviceName: this.buildWebRegisterName(register.cashier?.name),
          },
          include: { cashier: { select: { id: true, name: true } } },
        });
      }
    } else {
      if (cleanDeviceId) {
        register = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            deviceId: cleanDeviceId,
            status: "OPEN",
            registerSource: { not: "WEB" },
          },
          orderBy: { openedAt: "desc" },
        });
      }
      if (!register) {
        register = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            cashierId: userId,
            status: "OPEN",
            ...(cleanDeviceId ? { registerSource: { not: "WEB" } } : {}),
          },
          orderBy: { openedAt: "desc" },
        });
      }
    }

    if (!register) throw new NotFoundException("No hay una caja abierta para registrar movimientos");

    if (isWeb && isTargetingOther && register.cashierId !== userId) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'NOT_AVAILABLE_ON_WEB',
        message: 'Esta acción no está disponible desde la web',
      });
    }

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

  async getSummary(registerId: string, businessId: string, userRole?: string, userId?: string, deviceId?: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
        sales: { include: { payments: true, returns: { include: { items: true } } } },
        movements: true,
        tips: true,
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
    const summaryTipsCalc = this.computeTipsBreakdown((register as any).tips || []);
    const currentCashDec = openingCashDec.plus(totalCashDec).plus(summaryTipsCalc.allCashNioDec).plus(movementsInNioDec).minus(movementsOutNioDec);
    const currentCashUsdDec = totalCashUsdDec.plus(summaryTipsCalc.allCashUsdDec).plus(movementsInUsdDec).minus(movementsOutUsdDec);

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
        tipsSummary: summaryTipsCalc.tipsSummary,
      },
    };

    const obfuscated = await this.obfuscateRegister(result, businessId, userRole, userId, deviceId);
    return obfuscated;
  }
  /**
   * 319a - Entrega de propinas pendientes a un mesero desde el turno abierto del usuario.
   * Toma todas las propinas ACTIVE y no entregadas del mesero (de cualquier turno) con bloqueo FOR UPDATE,
   * crea CashMovement SALIDA (USD para efectivo dólares y NIO para efectivo córdobas + tarjeta + transferencia),
   * guarda el registro en pos_tip_payouts y marca cada propina como entregada (idempotente por clientRequestId).
   */
  async createTipPayout(
    dto: CreateTipPayoutDto,
    businessId: string,
    userId: string,
    userRole: string,
    deviceId?: string,
    clientPlatform?: string,
  ) {
    const cleanWaiterId = (dto.waiterId || '').trim();
    const cleanClientRequestId = (dto.clientRequestId || '').trim();
    if (!cleanWaiterId) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'WAITER_REQUIRED',
        message: 'Debes indicar el mesero al que se le entregarán las propinas.',
      });
    }
    if (!cleanClientRequestId) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'CLIENT_REQUEST_ID_REQUIRED',
        message: 'El identificador de solicitud es obligatorio.',
      });
    }

    const formatPayoutResponse = (payout: any, idempotentReplay: boolean) => ({
      id: payout.id,
      businessId: payout.businessId,
      cashRegisterId: payout.cashRegisterId,
      waiterId: payout.waiterId,
      waiterName: payout.waiterName,
      amountNio: Number(new Prisma.Decimal(payout.amountNio.toString()).toDecimalPlaces(2)),
      amountUsd: Number(new Prisma.Decimal(payout.amountUsd.toString()).toDecimalPlaces(2)),
      cashMovementIds: Array.isArray(payout.cashMovementIds) ? payout.cashMovementIds : [],
      createdById: payout.createdById,
      clientRequestId: payout.clientRequestId,
      createdAt: payout.createdAt,
      tipsCount: Array.isArray(payout.tips) ? payout.tips.length : 0,
      tips: (payout.tips || []).map((t: any) => ({
        id: t.id,
        saleId: t.saleId,
        invoiceNumber: t.sale?.invoiceNumber || null,
        cashRegisterId: t.cashRegisterId || null,
        amount: Number(new Prisma.Decimal(t.amount.toString()).toDecimalPlaces(2)),
        currency: t.currency || 'NIO',
        amountBase: Number(new Prisma.Decimal(t.amountBase.toString()).toDecimalPlaces(2)),
        paymentMethod: t.paymentMethod,
        createdAt: t.createdAt,
        paidAt: t.paidAt,
      })),
      idempotentReplay,
    });

    const isWeb = this.isWebPlatform(clientPlatform);
    const cleanDeviceId = deviceId?.trim() || null;

    // Buscar turno abierto del usuario
    let openShift: any = null;
    if (isWeb) {
      openShift = await this.prisma.cashRegister.findFirst({
        where: { businessId, cashierId: userId, status: 'OPEN', registerSource: 'WEB' },
        orderBy: { openedAt: 'desc' },
      });
    } else {
      if (cleanDeviceId) {
        openShift = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            cashierId: userId,
            deviceId: cleanDeviceId,
            status: 'OPEN',
            registerSource: { not: 'WEB' },
          },
          orderBy: { openedAt: 'desc' },
        });
      }
      if (!openShift) {
        openShift = await this.prisma.cashRegister.findFirst({
          where: {
            businessId,
            cashierId: userId,
            status: 'OPEN',
          },
          orderBy: { openedAt: 'desc' },
        });
      }
    }

    if (!openShift) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'NO_OPEN_SHIFT',
        message: 'Debes tener un turno de caja abierto para entregar propinas.',
      });
    }

    const executePayout = async () => {
      return this.prisma.$transaction(async (tx) => {
        // 1. Verificar idempotencia primero
        const existingPayout = await tx.tipPayout.findUnique({
          where: {
            businessId_clientRequestId: {
              businessId,
              clientRequestId: cleanClientRequestId,
            },
          },
          include: {
            tips: {
              orderBy: { createdAt: 'asc' },
              include: {
                sale: { select: { id: true, invoiceNumber: true } },
              },
            },
          },
        });
        if (existingPayout) {
          return formatPayoutResponse(existingPayout, true);
        }

        // 2. Validar que el mesero pertenece al negocio
        const waiter = await tx.waiter.findFirst({
          where: { id: cleanWaiterId, businessId },
          select: { id: true, name: true },
        });
        if (!waiter) {
          throw new NotFoundException({
            statusCode: 404,
            error: 'Not Found',
            code: 'WAITER_NOT_FOUND',
            message: 'El mesero seleccionado no existe en este negocio.',
          });
        }

        // 3. Revalidar que el turno sigue abierto
        const lockedShift = await tx.cashRegister.findFirst({
          where: { id: openShift.id, businessId, status: 'OPEN' },
          select: { id: true },
        });
        if (!lockedShift) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'NO_OPEN_SHIFT',
            message: 'Debes tener un turno de caja abierto para entregar propinas.',
          });
        }

        // 4. Bloquear todas las propinas ACTIVE y no entregadas del mesero (de cualquier turno)
        const pendingTips = await tx.$queryRaw<
          Array<{
            id: string;
            saleId: string;
            cashRegisterId: string | null;
            amount: any;
            currency: string;
            exchangeRate: any;
            amountBase: any;
            paymentMethod: string;
            createdAt: Date;
          }>
        >`
          SELECT id, "saleId", "cashRegisterId", amount, currency, "exchangeRate", "amountBase", "paymentMethod", "createdAt"
          FROM "pos_sale_tips"
          WHERE "businessId" = ${businessId}
            AND "waiterId" = ${waiter.id}
            AND status = 'ACTIVE'
            AND "paidAt" IS NULL
            AND "payoutId" IS NULL
          ORDER BY "createdAt" ASC, id ASC
          FOR UPDATE
        `;

        if (!pendingTips || pendingTips.length === 0) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'NO_PENDING_TIPS',
            message: 'Este mesero no tiene propinas pendientes.',
          });
        }

        // 5. Calcular totales por moneda:
        //    - Efectivo USD -> salida en US$ (monto en dólares)
        //    - Todo lo demás (efectivo NIO, tarjeta, transferencia) -> salida en C$ (monto base)
        let amountUsdDec = new Prisma.Decimal(0);
        let amountNioDec = new Prisma.Decimal(0);
        for (const t of pendingTips) {
          const method = (t.paymentMethod || '').toUpperCase();
          const curr = (t.currency || 'NIO').toUpperCase();
          if (method === 'EFECTIVO' && curr === 'USD') {
            amountUsdDec = amountUsdDec.plus(new Prisma.Decimal(t.amount.toString()));
          } else {
            amountNioDec = amountNioDec.plus(new Prisma.Decimal(t.amountBase.toString()));
          }
        }
        amountUsdDec = amountUsdDec.toDecimalPlaces(2);
        amountNioDec = amountNioDec.toDecimalPlaces(2);

        const concept = `Entrega de propinas — ${waiter.name}`;
        const cashMovementIds: string[] = [];

        if (amountUsdDec.greaterThan(0)) {
          const activeRate = await this.exchangeRateService.getCurrentRate(businessId, tx);
          const rateDec = new Prisma.Decimal(activeRate.rate.toString());
          const usdBaseDec = amountUsdDec.times(rateDec).toDecimalPlaces(2);
          const movUsd = await tx.cashMovement.create({
            data: {
              businessId,
              cashRegisterId: openShift.id,
              userId,
              type: MovementType.SALIDA,
              amount: amountUsdDec,
              concept,
              currency: 'USD',
              exchangeRate: rateDec,
              amountBase: usdBaseDec,
            },
          });
          cashMovementIds.push(movUsd.id);
        }

        if (amountNioDec.greaterThan(0)) {
          const movNio = await tx.cashMovement.create({
            data: {
              businessId,
              cashRegisterId: openShift.id,
              userId,
              type: MovementType.SALIDA,
              amount: amountNioDec,
              concept,
              currency: 'NIO',
              exchangeRate: new Prisma.Decimal(1),
              amountBase: amountNioDec,
            },
          });
          cashMovementIds.push(movNio.id);
        }

        const paidAt = new Date();
        const payout = await tx.tipPayout.create({
          data: {
            businessId,
            cashRegisterId: openShift.id,
            waiterId: waiter.id,
            waiterName: waiter.name,
            amountNio: amountNioDec,
            amountUsd: amountUsdDec,
            cashMovementIds,
            createdById: userId,
            clientRequestId: cleanClientRequestId,
          },
        });

        const tipIds = pendingTips.map((t) => t.id);
        const updatedCount = await tx.saleTip.updateMany({
          where: {
            id: { in: tipIds },
            status: 'ACTIVE',
            paidAt: null,
            payoutId: null,
          },
          data: {
            paidAt,
            paidById: userId,
            payoutId: payout.id,
          },
        });

        if (updatedCount.count !== tipIds.length) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'TIP_ALREADY_PAID',
            message: 'Una o más propinas ya fueron entregadas en otra operación.',
          });
        }

        await this.auditService.record(
          {
            businessId,
            userId,
            userRole,
            action: 'TIP_PAYOUT_CREATED',
            entityType: 'TipPayout',
            entityId: payout.id,
            after: {
              waiterId: waiter.id,
              waiterName: waiter.name,
              cashRegisterId: openShift.id,
              amountNio: Number(amountNioDec),
              amountUsd: Number(amountUsdDec),
              tipsCount: tipIds.length,
              tipIds,
              cashMovementIds,
              clientRequestId: cleanClientRequestId,
            },
          },
          tx,
        );

        const fullPayout = await tx.tipPayout.findUnique({
          where: { id: payout.id },
          include: {
            tips: {
              orderBy: { createdAt: 'asc' },
              include: {
                sale: { select: { id: true, invoiceNumber: true } },
              },
            },
          },
        });

        return formatPayoutResponse(fullPayout, false);
      });
    };

    try {
      return await executePayout();
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const existingPayout = await this.prisma.tipPayout.findUnique({
          where: {
            businessId_clientRequestId: {
              businessId,
              clientRequestId: cleanClientRequestId,
            },
          },
          include: {
            tips: {
              orderBy: { createdAt: 'asc' },
              include: {
                sale: { select: { id: true, invoiceNumber: true } },
              },
            },
          },
        });
        if (existingPayout) {
          return formatPayoutResponse(existingPayout, true);
        }
      }
      throw err;
    }
  }

  async drawerOpen(registerId: string | null | undefined, reason: string, businessId: string, userId: string, userRole: string, deviceId?: string) {
    let register;
    if (registerId && registerId !== 'current') {
      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId, businessId, status: "OPEN" },
      });
    } else {
      const cleanDeviceId = deviceId?.trim() || null;
      if (cleanDeviceId) {
        register = await this.prisma.cashRegister.findFirst({
          where: { businessId, deviceId: cleanDeviceId, status: "OPEN" },
          orderBy: { openedAt: "desc" },
        });
      }
      if (!register) {
        register = await this.prisma.cashRegister.findFirst({
          where: { businessId, cashierId: userId, status: "OPEN" },
          orderBy: { openedAt: "desc" },
        });
      }
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
  async getOpenList(businessId: string) {
    const openShifts = await this.prisma.cashRegister.findMany({
      where: { businessId, status: "OPEN" },
      include: {
        cashier: { select: { id: true, name: true } },
      },
      orderBy: { openedAt: "asc" },
    });

    const deviceIds = Array.from(
      new Set(openShifts.map((s) => s.deviceId).filter((id): id is string => Boolean(id && id.trim()))),
    );

    const [devices, terminals] = await Promise.all([
      deviceIds.length > 0
        ? this.prisma.posDevice.findMany({
            where: { businessId, deviceId: { in: deviceIds } },
            select: { deviceId: true, category: true, platform: true, lastSeenAt: true },
          })
        : Promise.resolve([]),
      deviceIds.length > 0
        ? this.prisma.posTerminal.findMany({
            where: { businessId, deviceIdentifier: { in: deviceIds } },
            select: {
              deviceIdentifier: true,
              lastSeenAt: true,
              hasPendingOfflineSales: true,
              pendingSalesCount: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const deviceById = new Map(devices.map((d) => [d.deviceId, d]));
    const terminalById = new Map(terminals.map((t) => [t.deviceIdentifier, t]));

    return openShifts.map((s) => {
      const dev = s.deviceId ? deviceById.get(s.deviceId) : undefined;
      const term = s.deviceId ? terminalById.get(s.deviceId) : undefined;

      const rawSource = (s as any).registerSource as string | undefined;
      const registerSource: 'WEB' | 'DESKTOP' | 'MOBILE' =
        rawSource === 'WEB' || rawSource === 'MOBILE' || rawSource === 'DESKTOP'
          ? rawSource
          : this.resolveRegisterSource(dev?.platform, dev?.category);

      let lastSeenAt: Date | null = null;
      if (term?.lastSeenAt && dev?.lastSeenAt) {
        lastSeenAt = term.lastSeenAt > dev.lastSeenAt ? term.lastSeenAt : dev.lastSeenAt;
      } else {
        lastSeenAt = term?.lastSeenAt ?? dev?.lastSeenAt ?? null;
      }

      const isDesktop = registerSource === 'DESKTOP';
      const pendingOfflineSalesCount = isDesktop ? (term?.pendingSalesCount ?? 0) : 0;
      const hasPendingOfflineSales = isDesktop
        ? Boolean(term?.hasPendingOfflineSales || pendingOfflineSalesCount > 0)
        : false;

      return {
        id: s.id,
        deviceId: s.deviceId ?? null,
        deviceName: s.deviceName ?? null,
        registerSource,
        registerType: registerSource,
        cashierId: s.cashierId,
        cashierName: s.cashier?.name ?? null,
        openedAt: s.openedAt,
        openingCash: Number(s.openingCash),
        status: s.status,
        lastSeenAt,
        hasPendingOfflineSales,
        pendingOfflineSalesCount,
      };
    });
  }
}
