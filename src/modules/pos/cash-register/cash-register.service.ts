import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { OpenCashRegisterDto } from "./dto/open-register.dto";
import { CloseCashRegisterDto } from "./dto/close-register.dto";
import { CashMovementDto } from "./dto/cash-movement.dto";

@Injectable()
export class CashRegisterService {
  private readonly logger = new Logger(CashRegisterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getCurrent(businessId: string, cashierId: string) {
    return this.prisma.cashRegister.findFirst({
      where: { businessId, cashierId, status: "OPEN" },
      include: {
        movements: true,
        _count: { select: { sales: true } },
      },
      orderBy: { openedAt: "desc" },
    });
  }

  async findAll(businessId: string) {
    return this.prisma.cashRegister.findMany({
      where: { businessId },
      include: { cashier: { select: { id: true, name: true } }, _count: { select: { sales: true } } },
      orderBy: { openedAt: "desc" },
      take: 100,
    });
  }

  async open(dto: OpenCashRegisterDto, businessId: string, cashierId: string) {
    const existing = await this.prisma.cashRegister.findFirst({
      where: { businessId, cashierId, status: "OPEN" },
    });
    if (existing) {
      throw new BadRequestException("Ya tienes una caja abierta. Ciérrala antes de abrir una nueva.");
    }

    this.logger.log(`[open] cashier=${cashierId} businessId=${businessId} openingCash=${dto.openingCash}`);
    return this.prisma.cashRegister.create({
      data: { businessId, cashierId, openingCash: dto.openingCash, notes: dto.notes },
    });
  }

  async close(registerId: string, dto: CloseCashRegisterDto, businessId: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId, status: "OPEN" },
      include: {
        sales: { where: { status: "COMPLETED" } },
        movements: true,
      },
    });
    if (!register) throw new NotFoundException("Caja no encontrada o ya cerrada");

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
    const difference = dto.closingCash - expectedCash;

    this.logger.log(
      `[close] id=${registerId} expectedCash=${expectedCash.toFixed(2)} closingCash=${dto.closingCash} diff=${difference.toFixed(2)}`
    );

    return this.prisma.cashRegister.update({
      where: { id: registerId },
      data: {
        closedAt: new Date(),
        closingCash: dto.closingCash,
        expectedCash,
        difference,
        totalSales,
        totalCash,
        totalCard,
        totalTransfer,
        notes: dto.notes || register.notes,
        status: "CLOSED",
      },
    });
  }

  async addMovement(registerId: string, dto: CashMovementDto, businessId: string, userId: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId, status: "OPEN" },
    });
    if (!register) throw new NotFoundException("Caja no encontrada o ya cerrada");

    this.logger.log(`[addMovement] register=${registerId} tipo=${dto.type} monto=${dto.amount}`);
    return this.prisma.cashMovement.create({
      data: { businessId, cashRegisterId: registerId, userId, ...dto },
    });
  }

  async getSummary(registerId: string, businessId: string) {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: registerId, businessId },
      include: {
        cashier: { select: { name: true } },
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
      register,
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
