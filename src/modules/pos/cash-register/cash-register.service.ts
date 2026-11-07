import { Injectable, NotFoundException, BadRequestException, Logger, ForbiddenException, ConflictException, HttpException, HttpStatus } from "@nestjs/common";
import * as bcrypt from 'bcrypt';
import { PrismaService } from "../../../prisma/prisma.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto, CountedBreakdownDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";
import { MovementType, Prisma, UserRole } from "@prisma/client";
import { getSalePaymentBreakdown, parseCountedMethod } from "./pos-cash.utils";
import { PoliciesService } from '../policies/policies.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { ALLOWED_DISCREPANCY_REASONS } from './constants/discrepancy-reasons.constant';

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
    };
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
        },
      };
    }

    return whitelistBlindRegister(registerData);
  }

  async getCurrent(businessId: string, cashierId?: string, userRole?: string, deviceId?: string) {
    const cleanDeviceId = deviceId?.trim() || null;
    let register = null;

    if (cleanDeviceId) {
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, deviceId: cleanDeviceId, status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
          movements: true,
          sales: {
            orderBy: { createdAt: "desc" },
            include: { payments: true, returns: { include: { items: true } } },
          },
          _count: { select: { sales: true } },
        },
        orderBy: { openedAt: "desc" },
      });

      // Adopción en getCurrent: si esa computadora no tiene turno pero el usuario tiene uno abierto con deviceId nulo
      if (!register && cashierId) {
        const legacyShift = await this.prisma.cashRegister.findFirst({
          where: { businessId, cashierId, deviceId: null, status: "OPEN" },
          orderBy: { openedAt: "desc" },
        });
        if (legacyShift) {
          const posDev = await this.prisma.posDevice.findFirst({
            where: { businessId, deviceId: cleanDeviceId },
            select: { name: true },
          });
          await this.prisma.cashRegister.update({
            where: { id: legacyShift.id },
            data: {
              deviceId: cleanDeviceId,
              deviceName: posDev?.name || legacyShift.deviceName,
            },
          });
          register = await this.prisma.cashRegister.findUnique({
            where: { id: legacyShift.id },
            include: {
              cashier: { select: { id: true, name: true } },
              discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
              movements: true,
              sales: {
                orderBy: { createdAt: "desc" },
                include: { payments: true, returns: { include: { items: true } } },
              },
              _count: { select: { sales: true } },
            },
          });
        }
      }
    } else if (cashierId) {
      // Sin X-Device-Id: busca por usuario (SIN ATAJO AL NEGOCIO)
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, cashierId, status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
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
    return this.obfuscateRegister(this.formatRegister(register), businessId, userRole, cashierId, cleanDeviceId);
  }

  async findAll(businessId: string, userRole?: string, userId?: string) {
    const registers = await this.prisma.cashRegister.findMany({
      where: { businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
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
    return Promise.all(formatted.map(f => this.obfuscateRegister(f, businessId, userRole, userId)));
  }

  async open(
    dto: OpenCashRegisterDto,
    businessId: string,
    cashierId: string,
    deviceId?: string,
    deviceName?: string,
    userRole: string = UserRole.CAJERO,
  ) {
    const cleanDeviceId = deviceId?.trim() || null;
    let cleanDeviceName = deviceName?.trim() || null;

    if (cleanDeviceId) {
      if (!cleanDeviceName) {
        const posDev = await this.prisma.posDevice.findFirst({
          where: { businessId, deviceId: cleanDeviceId },
          select: { name: true },
        });
        cleanDeviceName = posDev?.name || null;
      }

      // Validar si esa computadora ya tiene turno abierto
      const openOnDevice = await this.prisma.cashRegister.findFirst({
        where: { businessId, deviceId: cleanDeviceId, status: "OPEN" },
      });
      if (openOnDevice) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'DEVICE_REGISTER_ALREADY_OPEN',
          message: 'Esta computadora ya tiene un turno de caja abierto.',
          error: 'Bad Request',
        });
      }

      // Adopción de turnos viejos: si no tiene turno y existe uno abierto del mismo usuario con deviceId nulo
      const legacyShift = await this.prisma.cashRegister.findFirst({
        where: { businessId, cashierId, deviceId: null, status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
          movements: true,
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

    const openingCash = Number(dto.openingCash ?? dto.initialAmount ?? dto.amount ?? 0);
    this.logger.log(`[open] cashier=${cashierId} businessId=${businessId} deviceId=${cleanDeviceId} openingCash=${openingCash}`);
    const created = await this.prisma.cashRegister.create({
      data: {
        businessId,
        cashierId,
        openingCash,
        notes: dto.notes,
        status: "OPEN",
        deviceId: cleanDeviceId,
        deviceName: cleanDeviceName,
      },
      include: {
        cashier: { select: { id: true, name: true } },
        discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
        movements: true,
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
  ) {
    const cleanDeviceId = (deviceId || dto.deviceId || '').trim() || null;
    let register;

    if (registerId && registerId !== 'close' && registerId !== 'current') {
      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId, businessId, status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
          sales: { include: { payments: true, returns: { include: { items: true } } } },
          movements: true,
        },
      });
    } else {
      if (cleanDeviceId) {
        register = await this.prisma.cashRegister.findFirst({
          where: { businessId, deviceId: cleanDeviceId, status: "OPEN" },
          include: {
            cashier: { select: { id: true, name: true } },
            discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
            sales: { include: { payments: true, returns: { include: { items: true } } } },
            movements: true,
          },
          orderBy: { openedAt: "desc" },
        });

        // Adopción si hay turno de este usuario con deviceId null
        if (!register && cashierId) {
          register = await this.prisma.cashRegister.findFirst({
            where: { businessId, cashierId, deviceId: null, status: "OPEN" },
            include: {
              cashier: { select: { id: true, name: true } },
              discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
              sales: { include: { payments: true, returns: { include: { items: true } } } },
              movements: true,
            },
            orderBy: { openedAt: "desc" },
          });
        }
      } else {
        register = await this.prisma.cashRegister.findFirst({
          where: { businessId, ...(cashierId ? { cashierId } : {}), status: "OPEN" },
          include: {
            cashier: { select: { id: true, name: true } },
            discrepancyAuthorizer: { select: { id: true, name: true, role: true } },
            sales: { include: { payments: true, returns: { include: { items: true } } } },
            movements: true,
          },
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
      if (cleanDeviceId && register.deviceId && register.deviceId !== cleanDeviceId) {
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

    const openingCashDec = new Prisma.Decimal(register.openingCash != null ? register.openingCash.toString() : 0);
    const expectedCashDec = openingCashDec.plus(totalCashDec).plus(movementsInNioDec).minus(movementsOutNioDec);
    const differenceDec = closingCashDec.minus(expectedCashDec);

    const expectedCashUsdDec = totalCashUsdDec.plus(movementsInUsdDec).minus(movementsOutUsdDec);
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
      },
    });

    await this.auditService.record({
      businessId,
      userId: cashierId || 'SYSTEM',
      userRole: userRole || 'SYSTEM',
      action: isAboveTolerance ? 'CIERRE_TURNO_CON_DESCUADRE' : (dto.reason ? 'CIERRE_TURNO_FORZADO' : 'CIERRE_TURNO'),
      entityType: 'CashRegister',
      entityId: register.id,
      approvedById: authorizedById || undefined,
      reason: finalNotes,
      before: isAboveTolerance ? {
        expectedCash: Number(expectedCashDec.toDecimalPlaces(2)),
        closingCash: Number(closingCashDec.toDecimalPlaces(2)),
        difference: Number(differenceDec.toDecimalPlaces(2)),
        recountAttempts: currentRecounts,
        reason: finalReason,
        note: finalDiscrepancyNote,
      } : undefined,
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
    return this.obfuscateRegister(formatted, businessId, userRole, cashierId, cleanDeviceId);
  }

  async addMovement(registerId: string | null | undefined, dto: CashMovementDto, businessId: string, userId: string, userRole: string, deviceId?: string, clientPlatform?: string) {
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

    if (!register) throw new NotFoundException("No hay una caja abierta para registrar movimientos");

    const isWeb = clientPlatform?.toLowerCase().startsWith('web');
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

    const obfuscated = await this.obfuscateRegister(result, businessId, userRole, userId, deviceId);
    return obfuscated;
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

    return openShifts.map((s) => ({
      id: s.id,
      deviceId: s.deviceId ?? null,
      deviceName: s.deviceName ?? null,
      cashierId: s.cashierId,
      cashierName: s.cashier?.name ?? null,
      openedAt: s.openedAt,
      openingCash: Number(s.openingCash),
      status: s.status,
    }));
  }
}
