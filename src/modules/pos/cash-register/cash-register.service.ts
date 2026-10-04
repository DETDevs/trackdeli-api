import { Injectable, NotFoundException, BadRequestException, Logger, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";
import { MovementType, Prisma } from "@prisma/client";
import { getSalePaymentBreakdown } from "./pos-cash.utils";
import { PoliciesService } from '../policies/policies.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class CashRegisterService {
  private readonly logger = new Logger(CashRegisterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policiesService: PoliciesService,
    private readonly auditService: AuditService,
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
    }));

    const completedSales = (register.sales || []).filter((s: any) => s.status === 'COMPLETED');
    let decCalculatedSales = new Prisma.Decimal(0);
    let decCalculatedCash = new Prisma.Decimal(0);
    let decCalculatedCard = new Prisma.Decimal(0);
    let decCalculatedTransfer = new Prisma.Decimal(0);

    for (const s of completedSales) {
      decCalculatedSales = decCalculatedSales.plus(new Prisma.Decimal(s.total != null ? s.total.toString() : 0));
      const breakdown = getSalePaymentBreakdown(s);
      decCalculatedCash = decCalculatedCash.plus(new Prisma.Decimal(breakdown.cash));
      decCalculatedCard = decCalculatedCard.plus(new Prisma.Decimal(breakdown.card));
      decCalculatedTransfer = decCalculatedTransfer.plus(new Prisma.Decimal(breakdown.transfer));
    }

    let decMovementsIn = new Prisma.Decimal(0);
    let decMovementsOut = new Prisma.Decimal(0);
    for (const m of movements) {
      const amt = new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0);
      if (m.type === 'IN') decMovementsIn = decMovementsIn.plus(amt);
      if (m.type === 'OUT') decMovementsOut = decMovementsOut.plus(amt);
    }

    const decInitialAmount = new Prisma.Decimal(register.openingCash ?? register.initialAmount ?? 0);

    const liveExpectedCash = decInitialAmount.plus(decCalculatedCash).plus(decMovementsIn).minus(decMovementsOut);
    const expectedCashDec = register.expectedCash != null ? new Prisma.Decimal(register.expectedCash.toString()) : liveExpectedCash;

    const actualAmountDec = register.closingCash != null 
      ? new Prisma.Decimal(register.closingCash.toString()) 
      : (register.actualAmount != null ? new Prisma.Decimal(register.actualAmount.toString()) : null);

    const differenceDec = register.difference != null 
      ? new Prisma.Decimal(register.difference.toString()) 
      : (actualAmountDec != null ? actualAmountDec.minus(expectedCashDec) : null);

    const cashierInfo = register.cashier
      ? { id: register.cashier.id, name: register.cashier.name }
      : (register.openedBy ?? null);

    const isClosed = register.status === 'CLOSED' || !!register.closedAt;
    const closedBy = isClosed ? cashierInfo : null;

    const initialAmount = Number(decInitialAmount.toDecimalPlaces(2));
    const expectedCash = Number(expectedCashDec.toDecimalPlaces(2));
    const actualAmount = actualAmountDec != null ? Number(actualAmountDec.toDecimalPlaces(2)) : null;
    const difference = differenceDec != null ? Number(differenceDec.toDecimalPlaces(2)) : null;
    const totalSales = register.totalSales != null 
      ? Number(new Prisma.Decimal(register.totalSales.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedSales.toDecimalPlaces(2));
    const totalCash = register.totalCash != null 
      ? Number(new Prisma.Decimal(register.totalCash.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedCash.toDecimalPlaces(2));
    const totalCard = register.totalCard != null 
      ? Number(new Prisma.Decimal(register.totalCard.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedCard.toDecimalPlaces(2));
    const totalTransfer = register.totalTransfer != null 
      ? Number(new Prisma.Decimal(register.totalTransfer.toString()).toDecimalPlaces(2)) 
      : Number(decCalculatedTransfer.toDecimalPlaces(2));
    const movementsIn = Number(decMovementsIn.toDecimalPlaces(2));
    const movementsOut = Number(decMovementsOut.toDecimalPlaces(2));

    return {
      ...register,
      openingCash: initialAmount,
      initialAmount,
      expectedCash,
      expectedAmount: expectedCash,
      closingCash: actualAmount,
      actualAmount,
      difference,
      totalSales,
      totalCash,
      totalCard,
      totalTransfer,
      movementsIn,
      movementsOut,
      salesCount: completedSales.length || register._count?.sales || 0,
      openedById: register.cashierId || register.openedById,
      openedBy: cashierInfo,
      closedBy,
      movements,
      sales: completedSales,
    };
  }

  async obfuscateRegister(registerData: any, businessId: string, userRole?: string) {
    if (userRole !== 'CAJERO') return registerData;
    const policies = await this.policiesService.get(businessId);
    if (!policies.blindCashClose) return registerData;

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
      };
    };

    if (registerData.register && registerData.summary) {
      return {
        register: whitelistBlindRegister(registerData.register),
        summary: {
          salesCount: registerData.summary.salesCount ?? 0,
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
          where: { status: "COMPLETED" },
          orderBy: { createdAt: "desc" },
          include: { payments: true },
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
            where: { status: "COMPLETED" },
            orderBy: { createdAt: "desc" },
            include: { payments: true },
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
          where: { status: "COMPLETED" },
          orderBy: { createdAt: "desc" },
          include: { payments: true },
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
        sales: { where: { status: "COMPLETED" }, include: { payments: true } },
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
          sales: { where: { status: "COMPLETED" }, include: { payments: true } },
          movements: true,
        },
      });
    } else {
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, ...(cashierId ? { cashierId } : {}), status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          sales: { where: { status: "COMPLETED" }, include: { payments: true } },
          movements: true,
        },
        orderBy: { openedAt: "desc" },
      });
    }

    if (!register) throw new NotFoundException("Caja no encontrada o ya cerrada");

    const policies = await this.policiesService.get(businessId);
    let closingCashDec = new Prisma.Decimal(0);
    
    if (dto.counted && dto.counted.CASH !== undefined) {
      closingCashDec = new Prisma.Decimal(dto.counted.CASH);
    } else {
      closingCashDec = new Prisma.Decimal(dto.closingCash ?? dto.actualAmount ?? dto.amount ?? 0);
    }

    let totalSalesDec = new Prisma.Decimal(0);
    let totalCashDec = new Prisma.Decimal(0);
    let totalCardDec = new Prisma.Decimal(0);
    let totalTransferDec = new Prisma.Decimal(0);
    let totalOtherDec = new Prisma.Decimal(0);
    let totalCreditDec = new Prisma.Decimal(0);

    for (const s of register.sales) {
      totalSalesDec = totalSalesDec.plus(new Prisma.Decimal(s.total != null ? s.total.toString() : 0));
      const breakdown = getSalePaymentBreakdown(s);
      totalCashDec = totalCashDec.plus(new Prisma.Decimal(breakdown.cash));
      totalCardDec = totalCardDec.plus(new Prisma.Decimal(breakdown.card));
      totalTransferDec = totalTransferDec.plus(new Prisma.Decimal(breakdown.transfer));
      totalOtherDec = totalOtherDec.plus(new Prisma.Decimal(breakdown.other));
      totalCreditDec = totalCreditDec.plus(new Prisma.Decimal(breakdown.credit));
    }

    let movementsInDec = new Prisma.Decimal(0);
    let movementsOutDec = new Prisma.Decimal(0);
    for (const m of register.movements) {
      const amt = new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0);
      if (m.type === "ENTRADA" || (m as any).type === "IN") {
        movementsInDec = movementsInDec.plus(amt);
      }
      if (m.type === "SALIDA" || (m as any).type === "OUT") {
        movementsOutDec = movementsOutDec.plus(amt);
      }
    }

    const openingCashDec = new Prisma.Decimal(register.openingCash != null ? register.openingCash.toString() : 0);
    const expectedCashDec = openingCashDec.plus(totalCashDec).plus(movementsInDec).minus(movementsOutDec);
    const differenceDec = closingCashDec.minus(expectedCashDec);

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

    const updateResult = await this.prisma.cashRegister.updateMany({
      where: { id: register.id, status: 'OPEN' },
      data: {
        closedAt: new Date(),
        closingCash: closingCashDec,
        expectedCash: expectedCashDec,
        difference: differenceDec,
        totalSales: totalSalesDec,
        totalCash: totalCashDec,
        totalCard: totalCardDec,
        totalTransfer: totalTransferDec,
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

    this.logger.log(`[addMovement] register=${register.id} tipo=${movementType} monto=${amount}`);
    const movement = await this.prisma.cashMovement.create({
      data: {
        businessId,
        cashRegisterId: register.id,
        userId,
        type: movementType,
        amount,
        concept,
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
    };
  }

  async getSummary(registerId: string, businessId: string, userRole?: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        sales: { where: { status: "COMPLETED" }, include: { payments: true } },
        movements: true,
      },
    });
    if (!register) throw new NotFoundException("Caja no encontrada");

    let totalSalesDec = new Prisma.Decimal(0);
    let totalCashDec = new Prisma.Decimal(0);
    let totalCardDec = new Prisma.Decimal(0);
    let totalTransferDec = new Prisma.Decimal(0);

    for (const s of register.sales) {
      totalSalesDec = totalSalesDec.plus(new Prisma.Decimal(s.total != null ? s.total.toString() : 0));
      const breakdown = getSalePaymentBreakdown(s);
      totalCashDec = totalCashDec.plus(new Prisma.Decimal(breakdown.cash));
      totalCardDec = totalCardDec.plus(new Prisma.Decimal(breakdown.card));
      totalTransferDec = totalTransferDec.plus(new Prisma.Decimal(breakdown.transfer));
    }

    let movementsInDec = new Prisma.Decimal(0);
    let movementsOutDec = new Prisma.Decimal(0);
    for (const m of register.movements) {
      const amt = new Prisma.Decimal(m.amount != null ? m.amount.toString() : 0);
      if (m.type === "ENTRADA" || (m as any).type === "IN") movementsInDec = movementsInDec.plus(amt);
      if (m.type === "SALIDA" || (m as any).type === "OUT") movementsOutDec = movementsOutDec.plus(amt);
    }

    const openingCashDec = new Prisma.Decimal(register.openingCash != null ? register.openingCash.toString() : 0);
    const currentCashDec = openingCashDec.plus(totalCashDec).plus(movementsInDec).minus(movementsOutDec);

    const formatted = this.formatRegister(register);

    const result = {
      register: formatted,
      summary: {
        totalSales: Number(totalSalesDec.toDecimalPlaces(2)),
        totalCash: Number(totalCashDec.toDecimalPlaces(2)),
        totalCard: Number(totalCardDec.toDecimalPlaces(2)),
        totalTransfer: Number(totalTransferDec.toDecimalPlaces(2)),
        movementsIn: Number(movementsInDec.toDecimalPlaces(2)),
        movementsOut: Number(movementsOutDec.toDecimalPlaces(2)),
        currentCash: Number(currentCashDec.toDecimalPlaces(2)),
        salesCount: register.sales.length,
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
}
