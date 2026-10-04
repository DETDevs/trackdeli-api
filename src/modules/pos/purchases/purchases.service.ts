import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { Prisma, PurchaseStatus, StockMovementType, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PoliciesService } from '../policies/policies.service';
import { AuditService } from '../audit/audit.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { VoidPurchaseDto } from './dto/void-purchase.dto';

@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policiesService: PoliciesService,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreatePurchaseDto, businessId: string, userId: string) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PURCHASE_ITEMS_REQUIRED',
        message: 'La compra debe contener al menos un ítem.',
      });
    }

    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findFirst({
        where: { id: dto.supplierId, businessId },
      });
      if (!supplier) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'SUPPLIER_NOT_FOUND',
          message: 'Proveedor no encontrado en este negocio.',
        });
      }
    }

    const trimmedInvoice = dto.invoiceNumber ? dto.invoiceNumber.trim() : null;
    if (trimmedInvoice && dto.supplierId && !dto.force) {
      const existing = await this.prisma.purchase.findFirst({
        where: {
          businessId,
          supplierId: dto.supplierId,
          invoiceNumber: trimmedInvoice,
          status: PurchaseStatus.RECEIVED,
        },
      });
      if (existing) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'DUPLICATE_PURCHASE_INVOICE',
          message: {
            code: 'DUPLICATE_PURCHASE_INVOICE',
            message: `Ya existe una compra registrada con la factura "${trimmedInvoice}" para este proveedor. Envíe "force: true" para registrarla de todos modos.`,
            existingPurchaseId: existing.id,
          },
        });
      }
    }

    let calculatedTotalDec = new Prisma.Decimal(0);
    for (const item of dto.items) {
      const itemSubtotal = new Prisma.Decimal(item.quantity).times(new Prisma.Decimal(item.unitCost));
      calculatedTotalDec = calculatedTotalDec.plus(itemSubtotal);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.create({
        data: {
          businessId,
          supplierId: dto.supplierId || null,
          invoiceNumber: trimmedInvoice,
          purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : new Date(),
          notes: dto.notes ? dto.notes.trim() : null,
          status: PurchaseStatus.RECEIVED,
          total: calculatedTotalDec,
          createdById: userId,
        },
      });

      for (const item of dto.items) {
        // Lock product row to prevent race conditions
        await tx.$queryRaw`SELECT id FROM pos_products WHERE id = ${item.productId} FOR UPDATE`;
        const product = await tx.product.findFirst({
          where: { id: item.productId, businessId },
        });

        if (!product) {
          throw new NotFoundException({
            statusCode: 404,
            error: 'Not Found',
            code: 'PRODUCT_NOT_FOUND',
            message: `Producto con ID "${item.productId}" no encontrado.`,
          });
        }

        const itemSubtotal = new Prisma.Decimal(item.quantity).times(new Prisma.Decimal(item.unitCost));
        await tx.purchaseItem.create({
          data: {
            purchaseId: purchase.id,
            productId: product.id,
            quantity: item.quantity,
            unitCost: new Prisma.Decimal(item.unitCost),
            subtotal: itemSubtotal,
          },
        });

        const stockBefore = product.stock;
        const stockAfter = stockBefore + item.quantity;
        const oldCost = product.cost;
        const newCost = item.unitCost;

        if (product.trackStock) {
          await tx.product.update({
            where: { id: product.id },
            data: {
              stock: { increment: item.quantity },
              cost: newCost,
            },
          });

          await tx.stockMovement.create({
            data: {
              businessId,
              productId: product.id,
              userId,
              type: StockMovementType.COMPRA,
              quantity: item.quantity,
              stockBefore,
              stockAfter,
              cost: newCost,
              concept: `Compra factura ${trimmedInvoice || 'S/N'}`,
              reference: purchase.id,
            },
          });
        } else {
          await tx.product.update({
            where: { id: product.id },
            data: { cost: newCost },
          });
        }

        await tx.productCostHistory.create({
          data: {
            businessId,
            productId: product.id,
            oldCost,
            newCost,
            purchaseId: purchase.id,
            reason: `Compra factura ${trimmedInvoice || 'S/N'}`,
          },
        });
      }

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole: UserRole.ENCARGADO,
          action: 'PURCHASE_CREATED',
          entityType: 'Purchase',
          entityId: purchase.id,
          after: {
            invoiceNumber: trimmedInvoice,
            supplierId: dto.supplierId,
            total: Number(calculatedTotalDec),
            itemsCount: dto.items.length,
          },
        },
        tx as any,
      );

      return tx.purchase.findUniqueOrThrow({
        where: { id: purchase.id },
        include: {
          supplier: true,
          createdBy: { select: { id: true, name: true, email: true } },
          items: { include: { product: true } },
        },
      });
    });

    this.logger.log(`[create] Compra registrada: id=${result.id} factura=${trimmedInvoice} total=${calculatedTotalDec.toFixed(2)}`);
    return this.formatPurchase(result);
  }

  async voidPurchase(id: string, businessId: string, userId: string, dto: VoidPurchaseDto) {
    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VOID_REASON_REQUIRED',
        message: 'El motivo de anulación es obligatorio.',
      });
    }

    const policies = await this.policiesService.get(businessId);

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock purchase row
      await tx.$queryRaw`SELECT id FROM pos_purchases WHERE id = ${id} FOR UPDATE`;
      const purchase = await tx.purchase.findFirst({
        where: { id, businessId },
        include: {
          items: { include: { product: true } },
        },
      });

      if (!purchase) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'PURCHASE_NOT_FOUND',
          message: 'Compra no encontrada.',
        });
      }

      if (purchase.status === PurchaseStatus.VOIDED) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'PURCHASE_ALREADY_VOIDED',
          message: 'Esta compra ya fue anulada previamente.',
        });
      }

      // Check negative stock constraints for tracked items
      for (const item of purchase.items) {
        await tx.$queryRaw`SELECT id FROM pos_products WHERE id = ${item.productId} FOR UPDATE`;
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });

        if (product.trackStock) {
          const resultingStock = product.stock - item.quantity;
          if (resultingStock < 0 && !policies.allowNegativeStock) {
            throw new UnprocessableEntityException({
              statusCode: 422,
              error: 'Unprocessable Entity',
              code: 'PURCHASE_VOID_INSUFFICIENT_STOCK',
              message: {
                code: 'PURCHASE_VOID_INSUFFICIENT_STOCK',
                message: `No se puede anular la compra: el stock de "${product.name}" quedaría en ${resultingStock} (disponible actual: ${product.stock}, a revertir: ${item.quantity}).`,
                productId: product.id,
                productName: product.name,
                currentStock: product.stock,
                revertQuantity: item.quantity,
                resultingStock,
              },
            });
          }
        }
      }

      // Revert stock and handle cost history
      for (const item of purchase.items) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
        const stockBefore = product.stock;
        const stockAfter = stockBefore - item.quantity;

        if (product.trackStock) {
          await tx.product.update({
            where: { id: product.id },
            data: { stock: { decrement: item.quantity } },
          });

          await tx.stockMovement.create({
            data: {
              businessId,
              productId: product.id,
              userId,
              type: StockMovementType.AJUSTE,
              quantity: -item.quantity,
              stockBefore,
              stockAfter,
              cost: product.cost,
              concept: `Anulación compra ${purchase.invoiceNumber || purchase.id}: ${dto.reason.trim()}`,
              reference: purchase.id,
            },
          });
        }

        // Cost reversion: only revert to oldCost if this purchase was the last cost change
        const lastCostHistory = await tx.productCostHistory.findFirst({
          where: { productId: product.id },
          orderBy: { date: 'desc' },
        });

        if (lastCostHistory && lastCostHistory.purchaseId === purchase.id && lastCostHistory.oldCost !== null) {
          await tx.product.update({
            where: { id: product.id },
            data: { cost: lastCostHistory.oldCost },
          });

          await tx.productCostHistory.create({
            data: {
              businessId,
              productId: product.id,
              oldCost: lastCostHistory.newCost,
              newCost: lastCostHistory.oldCost,
              purchaseId: purchase.id,
              reason: `Reversión costo por anulación compra ${purchase.invoiceNumber || purchase.id}`,
            },
          });
        }
      }

      const updated = await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          status: PurchaseStatus.VOIDED,
          voidedAt: new Date(),
          voidedById: userId,
          voidReason: dto.reason.trim(),
        },
        include: {
          supplier: true,
          createdBy: { select: { id: true, name: true, email: true } },
          voidedBy: { select: { id: true, name: true, email: true } },
          items: { include: { product: true } },
        },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole: UserRole.ENCARGADO,
          action: 'PURCHASE_VOIDED',
          entityType: 'Purchase',
          entityId: purchase.id,
          reason: dto.reason.trim(),
          before: { status: purchase.status },
          after: { status: PurchaseStatus.VOIDED, voidReason: dto.reason.trim() },
        },
        tx as any,
      );

      return updated;
    });

    this.logger.log(`[voidPurchase] Compra anulada: id=${id} businessId=${businessId}`);
    return this.formatPurchase(result);
  }

  async findAll(
    businessId: string,
    filters?: {
      from?: string;
      to?: string;
      supplierId?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const where: any = { businessId };
    if (filters?.supplierId) where.supplierId = filters.supplierId;
    if (filters?.status) where.status = filters.status;

    if (filters?.from || filters?.to) {
      where.purchaseDate = {};
      if (filters.from) {
        where.purchaseDate.gte = filters.from.includes('T') ? new Date(filters.from) : new Date(`${filters.from}T00:00:00.000Z`);
      }
      if (filters.to) {
        where.purchaseDate.lte = filters.to.includes('T') ? new Date(filters.to) : new Date(`${filters.to}T23:59:59.999Z`);
      }
    }

    const page = Math.max(1, Number(filters?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters?.limit) || 20));
    const skip = (page - 1) * limit;

    const [total, purchases] = await Promise.all([
      this.prisma.purchase.count({ where }),
      this.prisma.purchase.findMany({
        where,
        skip,
        take: limit,
        orderBy: { purchaseDate: 'desc' },
        include: {
          supplier: true,
          createdBy: { select: { id: true, name: true, email: true } },
          voidedBy: { select: { id: true, name: true, email: true } },
          items: { include: { product: true } },
        },
      }),
    ]);

    return {
      data: purchases.map((p) => this.formatPurchase(p)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string, businessId: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: {
        supplier: true,
        createdBy: { select: { id: true, name: true, email: true } },
        voidedBy: { select: { id: true, name: true, email: true } },
        items: { include: { product: true } },
      },
    });

    if (!purchase) {
      throw new NotFoundException('Compra no encontrada');
    }

    return this.formatPurchase(purchase);
  }

  private formatPurchase(purchase: any) {
    return {
      ...purchase,
      total: Number(new Prisma.Decimal(purchase.total != null ? purchase.total.toString() : 0).toDecimalPlaces(2)),
      items: (purchase.items || []).map((i: any) => ({
        ...i,
        unitCost: Number(new Prisma.Decimal(i.unitCost != null ? i.unitCost.toString() : 0).toDecimalPlaces(2)),
        subtotal: Number(new Prisma.Decimal(i.subtotal != null ? i.subtotal.toString() : 0).toDecimalPlaces(2)),
      })),
    };
  }
}
