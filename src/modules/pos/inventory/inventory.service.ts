import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { InventoryAdjustmentType, Prisma, StockMovementType, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PoliciesService } from '../policies/policies.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { PosAction } from '../permissions/permissions.service';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { BatchCountDto } from './dto/batch-count.dto';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policiesService: PoliciesService,
    private readonly approvalsService: ApprovalsService,
    private readonly auditService: AuditService,
  ) {}

  async createAdjustment(
    dto: CreateAdjustmentDto,
    businessId: string,
    userId: string,
    userRole: string,
  ) {
    const policies = await this.policiesService.get(businessId);
    let approvedById: string | null = null;

    if (userRole === UserRole.CAJERO && (policies.inventoryAdjustRequireApproval ?? true)) {
      if (!dto.approvalToken) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'APPROVAL_REQUIRED',
          message: {
            code: 'APPROVAL_REQUIRED',
            message: 'El ajuste de inventario requiere aprobación de un encargado.',
          },
        });
      }
    }

    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'ADJUSTMENT_REASON_REQUIRED',
        message: {
          code: 'ADJUSTMENT_REASON_REQUIRED',
          message: 'El motivo del ajuste es obligatorio.',
        },
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (dto.approvalToken) {
        approvedById = await this.approvalsService.consumeToken(
          businessId,
          PosAction.AJUSTE_INVENTARIO,
          dto.approvalToken,
          tx,
        );
      }

      // Lock product row to prevent race conditions with sales
      await tx.$queryRaw`SELECT id FROM pos_products WHERE id = ${dto.productId} FOR UPDATE`;
      const product = await tx.product.findFirst({
        where: { id: dto.productId, businessId },
      });

      if (!product) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'PRODUCT_NOT_FOUND',
          message: {
            code: 'PRODUCT_NOT_FOUND',
            message: 'Producto no encontrado.',
          },
        });
      }

      if (!product.trackStock) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'PRODUCT_DOES_NOT_TRACK_STOCK',
          message: {
            code: 'PRODUCT_DOES_NOT_TRACK_STOCK',
            message: `El producto "${product.name}" no tiene activado el control de inventario (trackStock).`,
          },
        });
      }

      let qtyDelta: number;
      if (dto.type === InventoryAdjustmentType.COUNT) {
        if (dto.countedQty === undefined || dto.countedQty === null) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'COUNTED_QTY_REQUIRED',
            message: {
              code: 'COUNTED_QTY_REQUIRED',
              message: 'countedQty es requerido para ajustes tipo COUNT.',
            },
          });
        }
        qtyDelta = dto.countedQty - product.stock;
      } else {
        if (dto.qtyDelta === undefined || dto.qtyDelta === null) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'QTY_DELTA_REQUIRED',
            message: {
              code: 'QTY_DELTA_REQUIRED',
              message: 'qtyDelta es requerido para este tipo de ajuste.',
            },
          });
        }
        qtyDelta = dto.qtyDelta;
      }

      const stockBefore = product.stock;
      const stockAfter = stockBefore + qtyDelta;

      if (stockAfter < 0 && !policies.allowNegativeStock) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'INSUFFICIENT_STOCK',
          message: {
            code: 'INSUFFICIENT_STOCK',
            message: `Stock insuficiente para realizar el ajuste en "${product.name}". Disponible: ${stockBefore}, solicitado cambio: ${qtyDelta}, stock resultante: ${stockAfter}.`,
            productId: product.id,
            productName: product.name,
            available: stockBefore,
            requested: Math.abs(qtyDelta),
            resultingStock: stockAfter,
          },
          details: {
            productId: product.id,
            productName: product.name,
            available: stockBefore,
            requested: Math.abs(qtyDelta),
            resultingStock: stockAfter,
          },
        });
      }

      await tx.product.update({
        where: { id: product.id },
        data: { stock: stockAfter },
      });

      const costAtTimeDec = product.cost != null ? new Prisma.Decimal(product.cost.toString()) : null;
      const costImpactDec = costAtTimeDec != null
        ? new Prisma.Decimal(qtyDelta).times(costAtTimeDec)
        : new Prisma.Decimal(0);

      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          businessId,
          productId: product.id,
          type: dto.type,
          qtyDelta,
          reason: dto.reason.trim(),
          notes: dto.notes ? dto.notes.trim() : null,
          userId,
          approvedById: approvedById || null,
          costAtTime: costAtTimeDec,
        },
        include: {
          product: { select: { id: true, name: true, barcode: true, sku: true, stock: true } },
          user: { select: { id: true, name: true, email: true } },
          approvedBy: { select: { id: true, name: true, email: true } },
        },
      });

      await tx.stockMovement.create({
        data: {
          businessId,
          productId: product.id,
          userId,
          type: StockMovementType.AJUSTE,
          quantity: qtyDelta,
          stockBefore,
          stockAfter,
          cost: costAtTimeDec,
          concept: `Ajuste ${dto.type}: ${dto.reason.trim()}`,
          reference: adjustment.id,
        },
      });

      const costImpact = Number(costImpactDec.toDecimalPlaces(2));

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole,
          action: 'INVENTORY_ADJUSTED',
          entityType: 'InventoryAdjustment',
          entityId: adjustment.id,
          reason: dto.reason.trim(),
          after: {
            productId: product.id,
            productName: product.name,
            type: dto.type,
            qtyDelta,
            stockBefore,
            stockAfter,
            costImpact,
            approvedById,
          },
        },
        tx as any,
      );

      if (userRole === UserRole.CAJERO) {
        const copy: any = { ...adjustment };
        delete copy.costAtTime;
        return {
          ...copy,
          stockBefore,
          stockAfter,
        };
      }

      return {
        ...adjustment,
        stockBefore,
        stockAfter,
        costImpact,
      };
    });

    this.logger.log(`[createAdjustment] Ajuste creado: id=${result.id} producto=${dto.productId} delta=${result.qtyDelta}`);
    return result;
  }

  async batchCount(
    dto: BatchCountDto,
    businessId: string,
    userId: string,
    userRole: string,
  ) {
    if (!dto.lines || dto.lines.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'BATCH_LINES_REQUIRED',
        message: {
          code: 'BATCH_LINES_REQUIRED',
          message: 'Debe incluir al menos una línea en el conteo físico.',
        },
      });
    }

    if (dto.lines.length > 200) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'BATCH_SIZE_EXCEEDED',
        message: {
          code: 'BATCH_SIZE_EXCEEDED',
          message: 'El conteo por lotes no puede exceder las 200 líneas.',
        },
      });
    }

    const policies = await this.policiesService.get(businessId);

    // Sort product IDs to prevent deadlock across concurrent transactions
    const sortedLines = [...dto.lines].sort((a, b) => a.productId.localeCompare(b.productId));

    const result = await this.prisma.$transaction(async (tx) => {
      const processedAdjustments: any[] = [];
      let totalCostImpactDec = new Prisma.Decimal(0);

      for (const line of sortedLines) {
        await tx.$queryRaw`SELECT id FROM pos_products WHERE id = ${line.productId} FOR UPDATE`;
        const product = await tx.product.findFirst({
          where: { id: line.productId, businessId },
        });

        if (!product) {
          throw new NotFoundException({
            statusCode: 404,
            error: 'Not Found',
            code: 'PRODUCT_NOT_FOUND',
            message: {
              code: 'PRODUCT_NOT_FOUND',
              message: `Producto con ID "${line.productId}" no encontrado.`,
            },
          });
        }

        if (!product.trackStock) {
          continue; // Productos sin trackStock se omiten del conteo físico
        }

        const qtyDelta = line.countedQty - product.stock;
        const stockBefore = product.stock;
        const stockAfter = line.countedQty;

        if (stockAfter < 0 && !policies.allowNegativeStock) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            error: 'Unprocessable Entity',
            code: 'INSUFFICIENT_STOCK',
            message: {
              code: 'INSUFFICIENT_STOCK',
              message: `El conteo para "${product.name}" no puede ser negativo (${stockAfter}).`,
              productId: product.id,
              productName: product.name,
              available: stockBefore,
              resultingStock: stockAfter,
            },
            details: {
              productId: product.id,
              productName: product.name,
              available: stockBefore,
              resultingStock: stockAfter,
            },
          });
        }

        await tx.product.update({
          where: { id: product.id },
          data: { stock: stockAfter },
        });

        const costAtTimeDec = product.cost != null ? new Prisma.Decimal(product.cost.toString()) : null;
        const costImpactDec = costAtTimeDec != null
          ? new Prisma.Decimal(qtyDelta).times(costAtTimeDec)
          : new Prisma.Decimal(0);

        totalCostImpactDec = totalCostImpactDec.plus(costImpactDec);

        const adjustment = await tx.inventoryAdjustment.create({
          data: {
            businessId,
            productId: product.id,
            type: InventoryAdjustmentType.COUNT,
            qtyDelta,
            reason: dto.reason.trim(),
            notes: `Conteo por lotes (${dto.lines.length} productos)`,
            userId,
            costAtTime: costAtTimeDec,
          },
        });

        await tx.stockMovement.create({
          data: {
            businessId,
            productId: product.id,
            userId,
            type: StockMovementType.AJUSTE,
            quantity: qtyDelta,
            stockBefore,
            stockAfter,
            cost: costAtTimeDec,
            concept: `Conteo físico: ${dto.reason.trim()}`,
            reference: adjustment.id,
          },
        });

        const costImpact = Number(costImpactDec.toDecimalPlaces(2));

        processedAdjustments.push({
          adjustmentId: adjustment.id,
          productId: product.id,
          productName: product.name,
          stockBefore,
          countedQty: line.countedQty,
          qtyDelta,
          costImpact,
        });
      }

      const totalCostImpact = Number(totalCostImpactDec.toDecimalPlaces(2));

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole,
          action: 'INVENTORY_BATCH_COUNT',
          entityType: 'InventoryAdjustment',
          entityId: businessId,
          reason: dto.reason.trim(),
          after: {
            linesCount: processedAdjustments.length,
            totalCostImpact,
          },
        },
        tx as any,
      );

      return {
        processedCount: processedAdjustments.length,
        totalCostImpact,
        adjustments: processedAdjustments,
      };
    });

    this.logger.log(`[batchCount] Conteo por lotes procesado: ${result.processedCount} líneas`);
    return result;
  }

  async findAllAdjustments(
    businessId: string,
    filters?: {
      productId?: string;
      type?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const where: any = { businessId };
    if (filters?.productId) where.productId = filters.productId;
    if (filters?.type) where.type = filters.type;

    if (filters?.from || filters?.to) {
      where.createdAt = {};
      if (filters.from) {
        where.createdAt.gte = filters.from.includes('T') ? new Date(filters.from) : new Date(`${filters.from}T00:00:00.000Z`);
      }
      if (filters.to) {
        where.createdAt.lte = filters.to.includes('T') ? new Date(filters.to) : new Date(`${filters.to}T23:59:59.999Z`);
      }
    }

    const page = Math.max(1, Number(filters?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters?.limit) || 20));
    const skip = (page - 1) * limit;

    const [total, adjustments] = await Promise.all([
      this.prisma.inventoryAdjustment.count({ where }),
      this.prisma.inventoryAdjustment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { id: true, name: true, barcode: true, sku: true, stock: true } },
          user: { select: { id: true, name: true } },
          approvedBy: { select: { id: true, name: true } },
        },
      }),
    ]);

    return {
      data: adjustments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOneAdjustment(id: string, businessId: string) {
    const adjustment = await this.prisma.inventoryAdjustment.findFirst({
      where: { id, businessId },
      include: {
        product: true,
        user: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!adjustment) {
      throw new NotFoundException('Ajuste de inventario no encontrado');
    }

    return adjustment;
  }
}
