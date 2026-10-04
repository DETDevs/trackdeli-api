import { Injectable, NotFoundException, BadRequestException, Logger, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";
import { MovementType } from "@prisma/client";
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
      amount: Number(m.amount || 0),
    }));

    const completedSales = (register.sales || []).filter((s: any) => s.status === 'COMPLETED');
    let calculatedSales = 0;
    let calculatedCash = 0;
    let calculatedCard = 0;
    let calculatedTransfer = 0;

    for (const s of completedSales) {
      calculatedSales += Number(s.total || 0);
      const breakdown = getSalePaymentBreakdown(s);
      calculatedCash += breakdown.cash;
      calculatedCard += breakdown.card;
      calculatedTransfer += breakdown.transfer;
    }

    const movementsIn = movements
      .filter((m: any) => m.type === 'IN')
      .reduce((sum: number, m: any) => sum + m.amount, 0);

    const movementsOut = movements
      .filter((m: any) => m.type === 'OUT')
      .reduce((sum: number, m: any) => sum + m.amount, 0);

    const initialAmount = Number(register.openingCash ?? register.initialAmount ?? 0);

    const liveExpectedCash = initialAmount + calculatedCash + movementsIn - movementsOut;
    const expectedCash = register.expectedCash != null ? Number(register.expectedCash) : liveExpectedCash;

    const actualAmount = register.closingCash != null ? Number(register.closingCash) : (register.actualAmount != null ? Number(register.actualAmount) : null);
    const difference = register.difference != null ? Number(register.difference) : (actualAmount != null ? actualAmount - expectedCash : null);

    const cashierInfo = register.cashier
      ? { id: register.cashier.id, name: register.cashier.name }
      : (register.openedBy ?? null);

    return {
      ...register,
      openingCash: initialAmount,
      initialAmount,
      expectedCash,
      expectedAmount: expectedCash,
      closingCash: actualAmount,
      actualAmount,
      difference,
      totalSales: register.totalSales != null ? Number(register.totalSales) : calculatedSales,
      totalCash: register.totalCash != null ? Number(register.totalCash) : calculatedCash,
      totalCard: register.totalCard != null ? Number(register.totalCard) : calculatedCard,
      totalTransfer: register.totalTransfer != null ? Number(register.totalTransfer) : calculatedTransfer,
      movementsIn,
      movementsOut,
      salesCount: completedSales.length || register._count?.sales || 0,
      openedById: register.cashierId || register.openedById,
      openedBy: cashierInfo,
      closedBy: cashierInfo,
      movements,
      sales: completedSales,
    };
  }

  async obfuscateRegister(registerData: any, businessId: string, userRole?: string) {
    if (userRole !== 'CAJERO') return registerData;
    const policies = await this.policiesService.get(businessId);
    if (policies.blindCashClose) {
      delete registerData.expectedCash;
      delete registerData.expectedAmount;
      delete registerData.difference;
      delete registerData.totalCash;
      delete registerData.totalCard;
      delete registerData.totalTransfer;
      delete registerData.totalSales;
      delete registerData.movementsIn;
      delete registerData.movementsOut;
      delete registerData.movements;
      delete registerData.sales;
      delete registerData.currentCash;
      delete registerData.salesDetails;
      
      if (registerData.register) {
        delete registerData.register.expectedCash;
        delete registerData.register.expectedAmount;
        delete registerData.register.difference;
        delete registerData.register.totalCash;
        delete registerData.register.totalCard;
        delete registerData.register.totalTransfer;
        delete registerData.register.totalSales;
        delete registerData.register.movementsIn;
        delete registerData.register.movementsOut;
        delete registerData.register.movements;
        delete registerData.register.sales;
        delete registerData.register.currentCash;
        delete registerData.register.salesDetails;
      }
      if (registerData.summary) {
        delete registerData.summary.totalCash;
        delete registerData.summary.currentCash;
        delete registerData.summary.totalSales;
        delete registerData.summary.movementsIn;
        delete registerData.summary.movementsOut;
      }
    }
    return registerData;
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
    let closingCash = 0;
    
    if (dto.counted && dto.counted.CASH !== undefined) {
      closingCash = dto.counted.CASH;
    } else {
      closingCash = Number(dto.closingCash ?? dto.actualAmount ?? dto.amount ?? 0);
    }

    let totalSales = 0;
    let totalCash = 0;
    let totalCard = 0;
    let totalTransfer = 0;
    let totalOther = 0;
    let totalCredit = 0;

    for (const s of register.sales) {
      totalSales += Number(s.total || 0);
      const breakdown = getSalePaymentBreakdown(s);
      totalCash += breakdown.cash;
      totalCard += breakdown.card;
      totalTransfer += breakdown.transfer;
      totalOther += breakdown.other;
      totalCredit += breakdown.credit;
    }

    const movementsIn = register.movements
      .filter((m) => m.type === "ENTRADA" || (m as any).type === "IN")
      .reduce((sum, m) => sum + Number(m.amount || 0), 0);
    const movementsOut = register.movements
      .filter((m) => m.type === "SALIDA" || (m as any).type === "OUT")
      .reduce((sum, m) => sum + Number(m.amount || 0), 0);

    const expectedCash = register.openingCash + totalCash + movementsIn - movementsOut;
    const difference = closingCash - expectedCash;

    if (Math.abs(difference) > Number(policies.cashDifferenceTolerance) && !dto.notes && !dto.reason) {
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
      `[close] id=${register.id} expectedCash=${expectedCash.toFixed(2)} closingCash=${closingCash} diff=${difference.toFixed(2)}`
    );

    const finalNotes = dto.reason ? `[FORZADO: ${dto.reason}] ${dto.notes || ''}`.trim() : (dto.notes || register.notes);

    const updateResult = await this.prisma.cashRegister.updateMany({
      where: { id: register.id, status: 'OPEN' },
      data: {
        closedAt: new Date(),
        closingCash,
        expectedCash,
        difference,
        totalSales,
        totalCash,
        totalCard,
        totalTransfer,
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
      action: difference !== 0 ? 'CIERRE_TURNO_CON_DIFERENCIA' : (dto.reason ? 'CIERRE_TURNO_FORZADO' : 'CIERRE_TURNO'),
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

    let totalSales = 0;
    let totalCash = 0;
    let totalCard = 0;
    let totalTransfer = 0;

    for (const s of register.sales) {
      totalSales += Number(s.total || 0);
      const breakdown = getSalePaymentBreakdown(s);
      totalCash += breakdown.cash;
      totalCard += breakdown.card;
      totalTransfer += breakdown.transfer;
    }

    const movementsIn = register.movements
      .filter((m) => m.type === "ENTRADA")
      .reduce((sum, m) => sum + Number(m.amount), 0);
    const movementsOut = register.movements
      .filter((m) => m.type === "SALIDA")
      .reduce((sum, m) => sum + Number(m.amount), 0);

    const formatted = this.formatRegister(register);
    
    let currentCash: number | null = Number(register.openingCash) + totalCash + movementsIn - movementsOut;

    const result = {
      register: formatted,
      summary: {
        totalSales,
        totalCash,
        movementsIn,
        movementsOut,
        currentCash,
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
