import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { MovementType, PosPaymentMethod, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { VoidExpenseDto } from './dto/void-expense.dto';
import { GetExpensesDto } from './dto/get-expenses.dto';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';
import { UpdateExpenseCategoryDto } from './dto/update-expense-category.dto';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  parseLocalDateToUtc,
} from '../../../common/utils/date.util';

@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private parseDateRange(from?: string, to?: string) {
    let gte: Date | undefined;
    let lte: Date | undefined;

    if (from && from.trim()) {
      const cleanFrom = from.trim();
      if (cleanFrom.includes('T')) {
        gte = new Date(cleanFrom);
      } else {
        gte = parseLocalDateToUtc(cleanFrom, '00:00:00.000', DEFAULT_BUSINESS_TIMEZONE);
      }
    }

    if (to && to.trim()) {
      const cleanTo = to.trim();
      if (cleanTo.includes('T')) {
        lte = new Date(cleanTo);
      } else {
        lte = parseLocalDateToUtc(cleanTo, '23:59:59.999', DEFAULT_BUSINESS_TIMEZONE);
      }
    }

    return { gte, lte };
  }

  async getCategories(businessId: string) {
    const count = await this.prisma.expenseCategory.count({ where: { businessId } });
    if (count === 0) {
      await this.seedDefaultCategories(businessId);
    }

    return this.prisma.expenseCategory.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async createCategory(businessId: string, dto: CreateExpenseCategoryDto) {
    const trimmedName = dto.name.trim();
    const existing = await this.prisma.expenseCategory.findFirst({
      where: {
        businessId,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });

    if (existing) {
      if (!existing.isActive) {
        // Reactivar si estaba inactiva
        return this.prisma.expenseCategory.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            description: dto.description?.trim() || existing.description,
            color: dto.color?.trim() || existing.color,
          },
        });
      }
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'CATEGORY_ALREADY_EXISTS',
        message: `Ya existe una categoría de gasto con el nombre "${trimmedName}".`,
      });
    }

    return this.prisma.expenseCategory.create({
      data: {
        businessId,
        name: trimmedName,
        description: dto.description ? dto.description.trim() : null,
        color: dto.color ? dto.color.trim() : '#6B7280',
        isDefault: false,
        isActive: true,
      },
    });
  }

  async updateCategory(id: string, businessId: string, dto: UpdateExpenseCategoryDto) {
    const category = await this.prisma.expenseCategory.findFirst({
      where: { id, businessId },
    });

    if (!category) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'CATEGORY_NOT_FOUND',
        message: 'Categoría de gasto no encontrada.',
      });
    }

    if (dto.name && dto.name.trim() !== category.name) {
      const duplicate = await this.prisma.expenseCategory.findFirst({
        where: {
          businessId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
          id: { not: id },
        },
      });
      if (duplicate) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'CATEGORY_NAME_DUPLICATE',
          message: `Ya existe otra categoría con el nombre "${dto.name.trim()}".`,
        });
      }
    }

    return this.prisma.expenseCategory.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        description: dto.description !== undefined ? (dto.description ? dto.description.trim() : null) : undefined,
        color: dto.color !== undefined ? (dto.color ? dto.color.trim() : null) : undefined,
        isActive: dto.isActive !== undefined ? dto.isActive : undefined,
      },
    });
  }

  async findAll(businessId: string, query: GetExpensesDto) {
    const where: Prisma.ExpenseWhereInput = { businessId };

    if (!query.includeVoided) {
      where.isVoided = false;
    }

    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }

    if (query.paymentMethod) {
      where.paymentMethod = query.paymentMethod;
    }

    const { gte, lte } = this.parseDateRange(query.from, query.to);
    if (gte || lte) {
      where.expenseDate = {};
      if (gte) where.expenseDate.gte = gte;
      if (lte) where.expenseDate.lte = lte;
    }

    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      where.OR = [
        { description: { contains: term, mode: 'insensitive' } },
        { receiptNumber: { contains: term, mode: 'insensitive' } },
        { category: { name: { contains: term, mode: 'insensitive' } } },
      ];
    }

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const [total, items, aggregate] = await Promise.all([
      this.prisma.expense.count({ where }),
      this.prisma.expense.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          category: { select: { id: true, name: true, color: true } },
          createdBy: { select: { id: true, name: true, email: true } },
          voidedBy: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.expense.aggregate({
        where: { ...where, isVoided: false },
        _sum: { amount: true },
      }),
    ]);

    const totalAmount = Number(aggregate._sum.amount || 0);

    const formattedItems = items.map((e) => ({
      id: e.id,
      categoryId: e.categoryId,
      category: e.category,
      amount: Number(e.amount),
      description: e.description,
      expenseDate: e.expenseDate,
      paymentMethod: e.paymentMethod,
      receiptNumber: e.receiptNumber,
      hasCashMovement: Boolean(e.cashMovementId),
      createdById: e.createdById,
      createdBy: e.createdBy,
      isVoided: e.isVoided,
      voidedAt: e.voidedAt,
      voidReason: e.voidReason,
      voidedBy: e.voidedBy,
      createdAt: e.createdAt,
    }));

    return {
      items: formattedItems,
      total,
      totalAmount: Math.round(totalAmount * 100) / 100,
      page,
      pageSize,
    };
  }

  async create(businessId: string, userId: string, dto: CreateExpenseDto) {
    if (dto.amount <= 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_EXPENSE_AMOUNT',
        message: 'El monto del gasto debe ser mayor a cero.',
      });
    }

    const category = await this.prisma.expenseCategory.findFirst({
      where: { id: dto.categoryId, businessId, isActive: true },
    });

    if (!category) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'CATEGORY_NOT_FOUND',
        message: 'Categoría de gasto no encontrada o inactiva.',
      });
    }

    const amountDec = new Prisma.Decimal(dto.amount);
    let parsedExpenseDate = new Date();
    if (dto.expenseDate && dto.expenseDate.trim()) {
      const cleanDate = dto.expenseDate.trim();
      parsedExpenseDate = cleanDate.includes('T')
        ? new Date(cleanDate)
        : parseLocalDateToUtc(cleanDate, '12:00:00.000', DEFAULT_BUSINESS_TIMEZONE);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let cashMovementId: string | null = null;
      let cashRegisterId: string | null = null;

      if (dto.deductFromCurrentShift) {
        if (dto.paymentMethod && dto.paymentMethod !== PosPaymentMethod.EFECTIVO) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'CASH_DEDUCTION_REQUIRES_CASH_METHOD',
            message: 'El descuento de turno de caja solo aplica cuando el método de pago es EFECTIVO.',
          });
        }

        const openShift = await tx.cashRegister.findFirst({
          where: { businessId, cashierId: userId, status: 'OPEN' },
          orderBy: { openedAt: 'desc' },
        });

        if (!openShift) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'NO_OPEN_CASH_REGISTER',
            message: 'No hay un turno de caja abierto para el usuario actual para descontar el gasto de la gaveta.',
          });
        }

        cashRegisterId = openShift.id;

        const movement = await tx.cashMovement.create({
          data: {
            businessId,
            cashRegisterId: openShift.id,
            userId,
            type: MovementType.SALIDA,
            amount: amountDec,
            concept: `Gasto: ${category.name} - ${dto.description.trim()}`,
            currency: 'NIO',
            exchangeRate: new Prisma.Decimal(1),
            amountBase: amountDec,
          },
        });
        cashMovementId = movement.id;
      }

      const expense = await tx.expense.create({
        data: {
          businessId,
          categoryId: category.id,
          amount: amountDec,
          description: dto.description.trim(),
          expenseDate: parsedExpenseDate,
          paymentMethod: dto.paymentMethod || PosPaymentMethod.EFECTIVO,
          receiptNumber: dto.receiptNumber ? dto.receiptNumber.trim() : null,
          cashRegisterId,
          cashMovementId,
          createdById: userId,
        },
        include: {
          category: { select: { id: true, name: true, color: true } },
          createdBy: { select: { id: true, name: true, email: true } },
        },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole: UserRole.ENCARGADO,
          action: 'GESTION_GASTOS',
          entityType: 'Expense',
          entityId: expense.id,
          after: {
            categoryId: category.id,
            categoryName: category.name,
            amount: Number(amountDec),
            description: expense.description,
            paymentMethod: expense.paymentMethod,
            cashMovementId,
          },
        },
        tx as any,
      );

      return expense;
    });

    this.logger.log(`[create] Gasto registrado: id=${result.id} categoria=${category.name} monto=${dto.amount}`);
    return {
      id: result.id,
      categoryId: result.categoryId,
      category: result.category,
      amount: Number(result.amount),
      description: result.description,
      expenseDate: result.expenseDate,
      paymentMethod: result.paymentMethod,
      receiptNumber: result.receiptNumber,
      hasCashMovement: Boolean(result.cashMovementId),
      createdById: result.createdById,
      createdBy: result.createdBy,
      isVoided: result.isVoided,
      createdAt: result.createdAt,
    };
  }

  async voidExpense(id: string, businessId: string, userId: string, dto: VoidExpenseDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      // Row lock on expense
      await tx.$queryRaw`SELECT id FROM pos_expenses WHERE id = ${id} FOR UPDATE`;

      const expense = await tx.expense.findFirst({
        where: { id, businessId },
        include: {
          category: true,
          cashMovement: {
            include: {
              cashRegister: { select: { id: true, status: true } },
            },
          },
        },
      });

      if (!expense) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'EXPENSE_NOT_FOUND',
          message: 'Gasto no encontrado.',
        });
      }

      if (expense.isVoided) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'EXPENSE_ALREADY_VOIDED',
          message: 'Este gasto ya fue anulado previamente.',
        });
      }

      let voidReasonNote = dto.reason.trim();

      // Compensatory cash movement if shift is OPEN
      if (expense.cashMovement) {
        const shift = expense.cashMovement.cashRegister;
        if (shift && shift.status === 'OPEN') {
          await tx.cashMovement.create({
            data: {
              businessId,
              cashRegisterId: shift.id,
              userId,
              type: MovementType.ENTRADA,
              amount: expense.amount,
              concept: `Reversión por anulación de gasto ${expense.category.name}: ${dto.reason.trim()}`,
              currency: 'NIO',
              exchangeRate: new Prisma.Decimal(1),
              amountBase: expense.amount,
            },
          });
        } else {
          voidReasonNote += ' (Turno de caja original cerrado; no se alteró arqueo histórico)';
        }
      }

      const voided = await tx.expense.update({
        where: { id: expense.id },
        data: {
          isVoided: true,
          voidedAt: new Date(),
          voidedById: userId,
          voidReason: voidReasonNote,
        },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole: UserRole.ENCARGADO,
          action: 'GESTION_GASTOS',
          entityType: 'Expense',
          entityId: expense.id,
          reason: `Anulación de gasto: ${voidReasonNote}`,
          after: {
            amount: Number(expense.amount),
            isVoided: true,
          },
        },
        tx as any,
      );

      return voided;
    });

    this.logger.log(`[voidExpense] Gasto anulado: id=${id}`);
    return {
      id: result.id,
      isVoided: true,
      voidReason: result.voidReason,
      voidedAt: result.voidedAt,
    };
  }

  private async seedDefaultCategories(businessId: string): Promise<void> {
    const defaults = [
      { name: 'Alquiler', description: 'Pago de arriendo del local comercial', color: '#6366F1' },
      { name: 'Servicios básicos', description: 'Luz, agua, internet, telefonía', color: '#06B6D4' },
      { name: 'Planilla y salarios', description: 'Sueldos, salarios y comisiones del personal', color: '#10B981' },
      { name: 'Mantenimiento', description: 'Reparaciones, pintura y mantenimiento de equipos', color: '#F59E0B' },
      { name: 'Transporte', description: 'Combustible, fletes y viáticos', color: '#EC4899' },
      { name: 'Publicidad', description: 'Marketing, redes sociales y material publicitario', color: '#8B5CF6' },
      { name: 'Impuestos y tasas', description: 'Alcaldía, DGI, licencias comerciales', color: '#EF4444' },
      { name: 'Insumos y limpieza', description: 'Bolsas, papelería, químicos y aseo', color: '#14B8A6' },
      { name: 'Varios', description: 'Otros gastos operativos menores', color: '#6B7280' },
    ];

    for (const def of defaults) {
      await this.prisma.expenseCategory.upsert({
        where: { businessId_name: { businessId, name: def.name } },
        update: {},
        create: {
          businessId,
          name: def.name,
          description: def.description,
          color: def.color,
          isDefault: true,
          isActive: true,
        },
      });
    }

    this.logger.log(`[seedDefaultCategories] Categorías por defecto inicializadas para negocio ${businessId}`);
  }
}
