import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";
import { MovementType } from "@prisma/client";

@Injectable()
export class CashRegisterService {
  private readonly logger = new Logger(CashRegisterService.name);

  constructor(private readonly prisma: PrismaService) {}

  private formatRegister(register: any) {
    if (!register) return null;
    const movements = (register.movements || []).map((m: any) => ({
      ...m,
      type: m.type === 'SALIDA' ? 'OUT' : 'IN',
      rawType: m.type,
      reason: m.concept || m.reason || 'Movimiento de caja',
      concept: m.concept || m.reason || 'Movimiento de caja',
      amount: Number(m.amount || 0),
    }));

    const initialAmount = Number(register.openingCash ?? register.initialAmount ?? 0);
    const expectedAmount = Number(register.expectedCash ?? register.expectedAmount ?? initialAmount);
    const actualAmount = register.closingCash != null ? Number(register.closingCash) : (register.actualAmount != null ? Number(register.actualAmount) : null);
    const difference = register.difference != null ? Number(register.difference) : null;

    const cashierInfo = register.cashier
      ? { id: register.cashier.id, name: register.cashier.name }
      : (register.openedBy ?? null);

    return {
      ...register,
      openingCash: initialAmount,
      initialAmount,
      expectedCash: expectedAmount,
      expectedAmount,
      closingCash: actualAmount,
      actualAmount,
      difference,
      openedById: register.cashierId || register.openedById,
      openedBy: cashierInfo,
      closedBy: cashierInfo,
      movements,
    };
  }

  async getCurrent(businessId: string, cashierId: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { businessId, cashierId, status: "OPEN" },
      include: {
        cashier: { select: { id: true, name: true } },
        movements: true,
        _count: { select: { sales: true } },
      },
      orderBy: { openedAt: "desc" },
    });
    return this.formatRegister(register);
  }

  async findAll(businessId: string) {
    const registers = await this.prisma.cashRegister.findMany({
      where: { businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        movements: true,
        _count: { select: { sales: true } },
      },
      orderBy: { openedAt: "desc" },
      take: 100,
    });
    return registers.map((r) => this.formatRegister(r));
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
      },
    });
    return this.formatRegister(created);
  }

  async close(registerId: string | null | undefined, dto: CloseCashRegisterDto, businessId: string, cashierId?: string) {
    let register;
    if (registerId && registerId !== 'close' && registerId !== 'current') {
      register = await this.prisma.cashRegister.findFirst({
        where: { id: registerId, businessId, status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          sales: { where: { status: "COMPLETED" } },
          movements: true,
        },
      });
    } else {
      register = await this.prisma.cashRegister.findFirst({
        where: { businessId, ...(cashierId ? { cashierId } : {}), status: "OPEN" },
        include: {
          cashier: { select: { id: true, name: true } },
          sales: { where: { status: "COMPLETED" } },
          movements: true,
        },
        orderBy: { openedAt: "desc" },
      });
    }

    if (!register) throw new NotFoundException("Caja no encontrada o ya cerrada");

    const closingCash = Number(dto.closingCash ?? dto.actualAmount ?? dto.amount ?? 0);
    const totalSales = register.sales.reduce((sum, s) => sum + s.total, 0);
    const totalCash = register.sales
      .filter((s) => s.paymentMethod === "EFECTIVO")
      .reduce((sum, s) => sum + s.total, 0);
    const totalCard = register.sales
      .filter((s) => s.paymentMethod === "TARJETA")
      .reduce((sum, s) => sum + s.total, 0);
    const totalTransfer = register.sales
      .filter((s) => s.paymentMethod === "TRANSFERENCIA")
      .reduce((sum, s) => sum + s.total, 0);

    const movementsIn = register.movements
      .filter((m) => m.type === "ENTRADA")
      .reduce((sum, m) => sum + m.amount, 0);
    const movementsOut = register.movements
      .filter((m) => m.type === "SALIDA")
      .reduce((sum, m) => sum + m.amount, 0);

    const expectedCash = register.openingCash + totalCash + movementsIn - movementsOut;
    const difference = closingCash - expectedCash;

    this.logger.log(
      `[close] id=${register.id} expectedCash=${expectedCash.toFixed(2)} closingCash=${closingCash} diff=${difference.toFixed(2)}`
    );

    const updated = await this.prisma.cashRegister.update({
      where: { id: register.id },
      data: {
        closedAt: new Date(),
        closingCash,
        expectedCash,
        difference,
        totalSales,
        totalCash,
        totalCard,
        totalTransfer,
        notes: dto.notes || register.notes,
        status: "CLOSED",
      },
      include: {
        cashier: { select: { id: true, name: true } },
        movements: true,
      },
    });
    return this.formatRegister(updated);
  }

  async addMovement(registerId: string | null | undefined, dto: CashMovementDto, businessId: string, userId: string) {
    let register;
    if (registerId && registerId !== 'movements' && registerId !== 'movement' && registerId !== 'current') {
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

    const concept = dto.concept || dto.reason || 'Movimiento de caja';
    const amount = Number(dto.amount);

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

    return {
      ...movement,
      type: movement.type === 'SALIDA' ? 'OUT' : 'IN',
      rawType: movement.type,
      reason: movement.concept,
      amount: Number(movement.amount),
    };
  }

  async getSummary(registerId: string, businessId: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId },
      include: {
        cashier: { select: { id: true, name: true } },
        sales: { where: { status: "COMPLETED" } },
        movements: true,
      },
    });
    if (!register) throw new NotFoundException("Caja no encontrada");

    const totalSales = register.sales.reduce((sum, s) => sum + s.total, 0);
    const totalCash = register.sales
      .filter((s) => s.paymentMethod === "EFECTIVO")
      .reduce((sum, s) => sum + s.total, 0);
    const movementsIn = register.movements
      .filter((m) => m.type === "ENTRADA")
      .reduce((sum, m) => sum + m.amount, 0);
    const movementsOut = register.movements
      .filter((m) => m.type === "SALIDA")
      .reduce((sum, m) => sum + m.amount, 0);

    return {
      register: this.formatRegister(register),
      summary: {
        totalSales,
        totalCash,
        movementsIn,
        movementsOut,
        currentCash: register.openingCash + totalCash + movementsIn - movementsOut,
        salesCount: register.sales.length,
      },
    };
  }
}
