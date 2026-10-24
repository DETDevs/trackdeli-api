import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InventoryAdjustmentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpdateBatchDto } from './dto/update-batch.dto';

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BatchAllocation {
  batchId: string;
  batchNumber: string;
  expiryDate: Date | null;
  quantity: number;
  cost: number | null;
}

export interface OfflineBatchAllocationResult {
  allocations: Array<{
    batchId: string;
    batchNumber: string;
    expiryDate: Date | null;
    quantity: number;
    cost: number | null;
    isExpired: boolean;
  }>;
  unallocatedQty: number;
  hasExpiredAllocations: boolean;
  totalAllocated: number;
}

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Determina si un producto debe gestionar inventario por lotes.
   * Requiere que AMBOS flags (negocio y producto) sean true.
   */
  isTracked(
    business: { tracksBatches?: boolean | null } | null | undefined,
    product: { tracksBatches?: boolean | null } | null | undefined,
  ): boolean {
    return Boolean(business?.tracksBatches && product?.tracksBatches);
  }

  /**
   * Recibe mercancía en un lote (compras o entradas).
   * Si el lote ya existe para este producto:
   * - Si las fechas de vencimiento difieren, rechaza con error claro.
   * - Si coincide o no tiene fecha, acumula la cantidad.
   * Mantiene Product.stock sincronizado con la suma de lotes.
   */
  async receive(
    tx: Prisma.TransactionClient,
    params: {
      businessId: string;
      productId: string;
      batchNumber: string;
      expiryDate?: Date | string | null;
      qty: number;
      cost?: number | null;
      purchaseItemId?: string | null;
    },
  ) {
    const trimmedBatch = params.batchNumber.trim();
    if (!trimmedBatch) {
      throw new BadRequestException('El número de lote no puede estar vacío');
    }

    let normalizedExpiry: Date | null = null;
    if (params.expiryDate) {
      const parsed = new Date(params.expiryDate);
      if (isNaN(parsed.getTime())) {
        throw new BadRequestException('Fecha de vencimiento de lote inválida');
      }
      normalizedExpiry = parsed;
    }

    const existing = await tx.productBatch.findUnique({
      where: {
        businessId_productId_batchNumber: {
          businessId: params.businessId,
          productId: params.productId,
          batchNumber: trimmedBatch,
        },
      },
    });

    let batch;
    if (existing) {
      const existingDateStr = existing.expiryDate
        ? new Date(existing.expiryDate).toISOString().slice(0, 10)
        : null;
      const newDateStr = normalizedExpiry
        ? normalizedExpiry.toISOString().slice(0, 10)
        : null;

      if (existingDateStr && newDateStr && existingDateStr !== newDateStr) {
        throw new BadRequestException(
          `El lote "${trimmedBatch}" ya existe con una fecha de vencimiento distinta (${existingDateStr} vs ${newDateStr}). No se puede sobrescribir.`,
        );
      }

      const newQty = round3(Number(existing.quantity) + params.qty);
      batch = await tx.productBatch.update({
        where: { id: existing.id },
        data: {
          quantity: newQty,
          ...(params.cost != null && { cost: new Prisma.Decimal(params.cost.toString()) }),
          ...(normalizedExpiry && !existing.expiryDate && { expiryDate: normalizedExpiry }),
          ...(params.purchaseItemId && { purchaseItemId: params.purchaseItemId }),
          updatedAt: new Date(),
        },
      });
    } else {
      batch = await tx.productBatch.create({
        data: {
          businessId: params.businessId,
          productId: params.productId,
          batchNumber: trimmedBatch,
          expiryDate: normalizedExpiry,
          quantity: params.qty,
          cost: params.cost != null ? new Prisma.Decimal(params.cost.toString()) : null,
          purchaseItemId: params.purchaseItemId ?? null,
        },
      });
    }

    await this.syncProductStock(tx, params.productId);
    return batch;
  }

  /**
   * Asignación FEFO (First Expired, First Out) con bloqueo a nivel de fila (FOR UPDATE).
   * Solo asigna lotes con quantity > 0 y no vencidos (expiryDate >= hoy o null).
   * Si no alcanza o solo hay vencidos, arroja error descriptivo.
   */
  async allocateFefo(
    tx: Prisma.TransactionClient,
    params: {
      businessId: string;
      productId: string;
      qty: number;
    },
  ): Promise<BatchAllocation[]> {
    const todayStr = new Date().toISOString().slice(0, 10);

    const batches: Array<{
      id: string;
      batchNumber: string;
      expiryDate: Date | null;
      quantity: any;
      cost: any;
    }> = await tx.$queryRawUnsafe(
      `SELECT "id", "batchNumber", "expiryDate", "quantity", "cost"
       FROM "pos_product_batches"
       WHERE "businessId" = $1
         AND "productId" = $2
         AND "quantity" > 0
         AND ("expiryDate" IS NULL OR "expiryDate" >= $3::date)
       ORDER BY "expiryDate" ASC NULLS LAST, "createdAt" ASC
       FOR UPDATE;`,
      params.businessId,
      params.productId,
      todayStr,
    );

    const totalAvailable = batches.reduce((sum, b) => sum + Number(b.quantity), 0);
    const requestedQty = round3(params.qty);

    if (totalAvailable < requestedQty) {
      // Verificar si existen lotes vencidos con stock para emitir el error preciso exigido
      const expiredBatches: any[] = await tx.$queryRawUnsafe(
        `SELECT "batchNumber", "expiryDate", "quantity"
         FROM "pos_product_batches"
         WHERE "businessId" = $1
           AND "productId" = $2
           AND "quantity" > 0
           AND "expiryDate" < $3::date
         ORDER BY "expiryDate" ASC
         LIMIT 1;`,
        params.businessId,
        params.productId,
        todayStr,
      );

      if (expiredBatches.length > 0) {
        const exp = expiredBatches[0];
        const d = new Date(exp.expiryDate);
        const day = String(d.getUTCDate()).padStart(2, '0');
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const year = d.getUTCFullYear();
        const formattedDate = `${day}/${month}/${year}`;
        throw new BadRequestException(
          `No se puede vender: producto vencido el ${formattedDate} (Lote: ${exp.batchNumber})`,
        );
      }

      throw new BadRequestException(
        `Stock insuficiente en lotes vigentes para el producto (disponible en lotes vigentes: ${round3(totalAvailable)}, solicitado: ${requestedQty})`,
      );
    }

    let remaining = requestedQty;
    const allocations: BatchAllocation[] = [];

    for (const batch of batches) {
      if (remaining <= 0) break;
      const batchQty = Number(batch.quantity);
      const take = Math.min(batchQty, remaining);
      const newBatchQty = round3(batchQty - take);

      await tx.productBatch.update({
        where: { id: batch.id },
        data: { quantity: newBatchQty },
      });

      allocations.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity: take,
        cost: batch.cost != null ? Number(batch.cost) : null,
      });

      remaining = round3(remaining - take);
    }

    await this.syncProductStock(tx, params.productId);
    return allocations;
  }

  /**
   * Asignación de lotes para ventas OFFLINE sincronizadas (186d).
   * Regla no negociable: Una venta offline YA OCURRIÓ, el cliente se llevó el producto.
   * Por motivos de inventario/lotes la venta NUNCA se rechaza.
   * Orden de asignación:
   * (a) Lotes vigentes (expiryDate IS NULL o >= hoy) ordenados por FEFO.
   * (b) Si no alcanza, lotes vencidos ordenados por FEFO (marcados como isExpired: true).
   * (c) Si aún falta, la cantidad restante queda sin lote (unallocatedQty > 0).
   * Ningún lote queda con cantidad negativa (mínimo 0).
   * Product.stock se sincroniza con la suma de lotes restantes (invariante del modelo).
   */
  async allocateOffline(
    tx: Prisma.TransactionClient,
    params: {
      businessId: string;
      productId: string;
      qty: number;
    },
  ): Promise<OfflineBatchAllocationResult> {
    const todayStr = new Date().toISOString().slice(0, 10);
    const requestedQty = round3(params.qty);

    if (requestedQty <= 0) {
      return {
        allocations: [],
        unallocatedQty: 0,
        hasExpiredAllocations: false,
        totalAllocated: 0,
      };
    }

    // Consulta con bloqueo FOR UPDATE: primero lotes vigentes, luego vencidos
    const batches: Array<{
      id: string;
      batchNumber: string;
      expiryDate: Date | null;
      quantity: any;
      cost: any;
    }> = await tx.$queryRawUnsafe(
      `SELECT "id", "batchNumber", "expiryDate", "quantity", "cost"
       FROM "pos_product_batches"
       WHERE "businessId" = $1
         AND "productId" = $2
         AND "quantity" > 0
       ORDER BY
         CASE WHEN ("expiryDate" IS NULL OR "expiryDate" >= $3::date) THEN 0 ELSE 1 END ASC,
         "expiryDate" ASC NULLS LAST,
         "createdAt" ASC
       FOR UPDATE;`,
      params.businessId,
      params.productId,
      todayStr,
    );

    let remaining = requestedQty;
    const allocations: Array<{
      batchId: string;
      batchNumber: string;
      expiryDate: Date | null;
      quantity: number;
      cost: number | null;
      isExpired: boolean;
    }> = [];
    let hasExpiredAllocations = false;
    let totalAllocated = 0;

    for (const batch of batches) {
      if (remaining <= 0) break;
      const batchQty = Number(batch.quantity);
      if (batchQty <= 0) continue;

      const take = Math.min(batchQty, remaining);
      const newBatchQty = round3(batchQty - take);

      await tx.productBatch.update({
        where: { id: batch.id },
        data: { quantity: newBatchQty },
      });

      const isExpired = Boolean(
        batch.expiryDate &&
          new Date(batch.expiryDate).toISOString().slice(0, 10) < todayStr,
      );

      if (isExpired) {
        hasExpiredAllocations = true;
      }

      allocations.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity: take,
        cost: batch.cost != null ? Number(batch.cost) : null,
        isExpired,
      });

      totalAllocated = round3(totalAllocated + take);
      remaining = round3(remaining - take);
    }

    const unallocatedQty = round3(Math.max(0, remaining));

    await this.syncProductStock(tx, params.productId);

    return {
      allocations,
      unallocatedQty,
      hasExpiredAllocations,
      totalAllocated,
    };
  }

  /**
   * Reingresa cantidades a los lotes originales de donde salió una venta.
   * Utilizado en devoluciones de venta con restock y en anulación de venta.
   */
  async returnToBatches(
    tx: Prisma.TransactionClient,
    saleItemId: string,
    returnQty: number,
  ) {
    const allocations = await tx.saleItemBatch.findMany({
      where: { saleItemId },
      include: { batch: true },
      orderBy: { createdAt: 'desc' },
    });

    if (allocations.length === 0) {
      return;
    }

    let toReturn = round3(returnQty);
    for (const alloc of allocations) {
      if (toReturn <= 0) break;
      const allocQty = Number(alloc.quantity);
      const restoreQty = Math.min(allocQty, toReturn);

      await tx.productBatch.update({
        where: { id: alloc.batchId },
        data: {
          quantity: { increment: restoreQty },
        },
      });

      toReturn = round3(toReturn - restoreQty);
    }

    const firstBatch = allocations[0]?.batch;
    if (firstBatch) {
      await this.syncProductStock(tx, firstBatch.productId);
    }
  }

  /**
   * Ajuste de stock por lote.
   * - Si delta < 0:
   *   - Si tipo es EXPIRED: requiere batchId (incluso si está vencido).
   *   - Si no hay batchId: aplica salida FEFO.
   * - Si delta > 0:
   *   - Si no hay batchId: crea/incrementa lote 'AJUSTE' sin fecha.
   */
  async adjust(
    tx: Prisma.TransactionClient,
    params: {
      businessId: string;
      productId: string;
      delta: number;
      type?: InventoryAdjustmentType;
      batchId?: string;
    },
  ) {
    const delta = round3(params.delta);

    if (delta < 0) {
      const take = Math.abs(delta);

      if (params.type === InventoryAdjustmentType.EXPIRED) {
        if (!params.batchId) {
          throw new BadRequestException(
            'El ajuste por vencimiento (EXPIRED) requiere especificar el lote (batchId)',
          );
        }
        const batch = await tx.productBatch.findFirst({
          where: {
            id: params.batchId,
            businessId: params.businessId,
            productId: params.productId,
          },
        });
        if (!batch) {
          throw new NotFoundException(`Lote '${params.batchId}' no encontrado`);
        }
        if (Number(batch.quantity) < take) {
          throw new BadRequestException(
            `El lote ${batch.batchNumber} solo tiene ${batch.quantity} unidades (solicitado a dar de baja: ${take})`,
          );
        }
        const updated = await tx.productBatch.update({
          where: { id: batch.id },
          data: { quantity: { decrement: take } },
        });
        await this.syncProductStock(tx, params.productId);
        return { batchId: updated.id, batchNumber: updated.batchNumber, quantity: -take };
      }

      if (params.batchId) {
        const batch = await tx.productBatch.findFirst({
          where: {
            id: params.batchId,
            businessId: params.businessId,
            productId: params.productId,
          },
        });
        if (!batch) {
          throw new NotFoundException(`Lote '${params.batchId}' no encontrado`);
        }
        if (Number(batch.quantity) < take) {
          throw new BadRequestException(
            `El lote ${batch.batchNumber} solo tiene ${batch.quantity} unidades (solicitado: ${take})`,
          );
        }
        const updated = await tx.productBatch.update({
          where: { id: batch.id },
          data: { quantity: { decrement: take } },
        });
        await this.syncProductStock(tx, params.productId);
        return { batchId: updated.id, batchNumber: updated.batchNumber, quantity: -take };
      }

      // Sin batchId específico: salida FEFO
      const allocs = await this.allocateFefo(tx, {
        businessId: params.businessId,
        productId: params.productId,
        qty: take,
      });
      return allocs[0];
    }

    if (delta > 0) {
      if (params.batchId) {
        const batch = await tx.productBatch.findFirst({
          where: {
            id: params.batchId,
            businessId: params.businessId,
            productId: params.productId,
          },
        });
        if (!batch) {
          throw new NotFoundException(`Lote '${params.batchId}' no encontrado`);
        }
        const updated = await tx.productBatch.update({
          where: { id: batch.id },
          data: { quantity: { increment: delta } },
        });
        await this.syncProductStock(tx, params.productId);
        return { batchId: updated.id, batchNumber: updated.batchNumber, quantity: delta };
      }

      // Delta positivo sin batchId -> acumula o crea lote 'AJUSTE'
      const batch = await this.receive(tx, {
        businessId: params.businessId,
        productId: params.productId,
        batchNumber: 'AJUSTE',
        expiryDate: null,
        qty: delta,
      });
      return { batchId: batch.id, batchNumber: 'AJUSTE', quantity: delta };
    }

    return null;
  }

  /**
   * Crea o asegura el lote 'INICIAL' (o personalizado) cuando un producto activa tracksBatches
   * o se crea con stock inicial.
   */
  async ensureInitialBatch(
    tx: Prisma.TransactionClient | PrismaService,
    businessId: string,
    productId: string,
    currentStock: number,
    cost?: number | null,
    customBatch?: { batchNumber?: string; expiryDate?: Date | null },
  ) {
    if (currentStock <= 0) return null;

    const batchNumber = customBatch?.batchNumber?.trim() || 'INICIAL';
    const expiryDate = customBatch?.expiryDate !== undefined ? customBatch.expiryDate : null;

    const existingCount = await (tx as any).productBatch.count({
      where: { businessId, productId },
    });

    if (existingCount === 0) {
      const batch = await (tx as any).productBatch.create({
        data: {
          businessId,
          productId,
          batchNumber,
          expiryDate,
          quantity: currentStock,
          cost: cost != null ? new Prisma.Decimal(cost.toString()) : null,
        },
      });
      await this.syncProductStock(tx as any, productId);
      return batch;
    }

    return null;
  }

  /**
   * Invariante estricto: Product.stock = SUM(ProductBatch.quantity)
   */
  async syncProductStock(tx: Prisma.TransactionClient, productId: string) {
    const result: any[] = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM("quantity"), 0)::numeric AS total FROM "pos_product_batches" WHERE "productId" = $1;`,
      productId,
    );
    const total = result.length > 0 ? Number(result[0].total) : 0;
    await tx.product.update({
      where: { id: productId },
      data: { stock: total },
    });
  }

  /**
   * Lista los lotes de un producto.
   */
  async getBatchesByProduct(businessId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
      select: { id: true, name: true, tracksBatches: true, stock: true },
    });
    if (!product) {
      throw new NotFoundException(`Producto '${productId}' no encontrado`);
    }

    const batches = await this.prisma.productBatch.findMany({
      where: { businessId, productId },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return {
      product,
      batches: batches.map((b) => {
        let status = 'NORMAL';
        if (b.expiryDate) {
          const exp = new Date(b.expiryDate);
          exp.setHours(0, 0, 0, 0);
          const diffMs = exp.getTime() - today.getTime();
          const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          if (diffDays < 0) status = 'VENCIDO';
          else if (diffDays <= 30) status = 'CRITICO';
          else if (diffDays <= 60) status = 'PROXIMO';
        }
        return {
          id: b.id,
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate,
          quantity: Number(b.quantity),
          cost: b.cost != null ? Number(b.cost) : null,
          status,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        };
      }),
    };
  }

  /**
   * Reporte y alertas de lotes próximos a vencer o vencidos con existencias > 0.
   * Agrupa en VENCIDO, CRITICO (<=30), PROXIMO (31-60), NORMAL (>60 o sin fecha).
   * Calcula valueAtRisk = SUM(quantity * cost).
   */
  async getExpiringBatches(businessId: string, daysThreshold: number = 30) {
    const batches = await this.prisma.productBatch.findMany({
      where: {
        businessId,
        quantity: { gt: 0 },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            barcode: true,
            cost: true,
          },
        },
      },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const items: any[] = [];
    let totalValueAtRisk = 0;
    let totalUnits = 0;

    const summary = {
      vencidos: { count: 0, units: 0, valueAtRisk: 0 },
      criticos: { count: 0, units: 0, valueAtRisk: 0 },
      proximos: { count: 0, units: 0, valueAtRisk: 0 },
      normales: { count: 0, units: 0, valueAtRisk: 0 },
    };

    for (const b of batches) {
      const qty = Number(b.quantity);
      const unitCost = b.cost != null ? Number(b.cost) : Number(b.product?.cost ?? 0);
      const val = round2(qty * unitCost);

      let status: 'VENCIDO' | 'CRITICO' | 'PROXIMO' | 'NORMAL' = 'NORMAL';
      let daysRemaining: number | null = null;

      if (b.expiryDate) {
        const exp = new Date(b.expiryDate);
        exp.setHours(0, 0, 0, 0);
        const diffMs = exp.getTime() - today.getTime();
        daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (daysRemaining < 0) {
          status = 'VENCIDO';
          summary.vencidos.count++;
          summary.vencidos.units = round3(summary.vencidos.units + qty);
          summary.vencidos.valueAtRisk = round2(summary.vencidos.valueAtRisk + val);
        } else if (daysRemaining <= 30) {
          status = 'CRITICO';
          summary.criticos.count++;
          summary.criticos.units = round3(summary.criticos.units + qty);
          summary.criticos.valueAtRisk = round2(summary.criticos.valueAtRisk + val);
        } else if (daysRemaining <= 60) {
          status = 'PROXIMO';
          summary.proximos.count++;
          summary.proximos.units = round3(summary.proximos.units + qty);
          summary.proximos.valueAtRisk = round2(summary.proximos.valueAtRisk + val);
        } else {
          status = 'NORMAL';
          summary.normales.count++;
          summary.normales.units = round3(summary.normales.units + qty);
          summary.normales.valueAtRisk = round2(summary.normales.valueAtRisk + val);
        }
      } else {
        status = 'NORMAL';
        summary.normales.count++;
        summary.normales.units = round3(summary.normales.units + qty);
        summary.normales.valueAtRisk = round2(summary.normales.valueAtRisk + val);
      }

      totalUnits = round3(totalUnits + qty);
      totalValueAtRisk = round2(totalValueAtRisk + val);

      items.push({
        id: b.id,
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate,
        quantity: qty,
        unitCost,
        valueAtRisk: val,
        daysRemaining,
        status,
        product: b.product,
      });
    }

    return {
      thresholdDays: daysThreshold,
      summary,
      totalBatches: items.length,
      totalUnits,
      totalValueAtRisk,
      items,
    };
  }

  /**
   * Actualiza el número de lote y/o la fecha de vencimiento de un lote existente.
   * Sirve para ponerle fecha real a lotes 'INICIAL'. NO permite modificar quantity.
   */
  async updateBatch(
    businessId: string,
    id: string,
    dto: UpdateBatchDto,
    userId: string,
    userRole: string,
  ) {
    const batch = await this.prisma.productBatch.findFirst({
      where: { id, businessId },
      include: { product: { select: { id: true, name: true, sku: true } } },
    });
    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    const dataToUpdate: any = {};

    if (dto.batchNumber !== undefined && dto.batchNumber.trim() !== batch.batchNumber) {
      const newBatchNumber = dto.batchNumber.trim();
      if (!newBatchNumber) {
        throw new BadRequestException('El número de lote no puede estar vacío');
      }
      const existing = await this.prisma.productBatch.findFirst({
        where: {
          businessId,
          productId: batch.productId,
          batchNumber: newBatchNumber,
          id: { not: id },
        },
      });
      if (existing) {
        throw new ConflictException(
          `Ya existe un lote con el número '${newBatchNumber}' para este producto`,
        );
      }
      dataToUpdate.batchNumber = newBatchNumber;
    }

    if (dto.expiryDate !== undefined) {
      dataToUpdate.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
    }

    const updated = await this.prisma.productBatch.update({
      where: { id },
      data: dataToUpdate,
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: 'BATCH_UPDATE',
      entityType: 'ProductBatch',
      entityId: batch.id,
      before: { batchNumber: batch.batchNumber, expiryDate: batch.expiryDate },
      after: { batchNumber: updated.batchNumber, expiryDate: updated.expiryDate },
      reason: 'Edición de número de lote o fecha de vencimiento',
    });

    return updated;
  }

  /**
   * Reporte de trazabilidad completa de un lote: compras de origen, ventas,
   * devoluciones, ajustes y bajas por vencimiento.
   */
  async getBatchTraceability(
    businessId: string,
    params: { batchId?: string; productId?: string; batchNumber?: string },
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { tracksBatches: true },
    });
    if (!business?.tracksBatches) {
      return null;
    }

    const where: any = { businessId };
    if (params.batchId) {
      where.id = params.batchId;
    } else if (params.productId && params.batchNumber) {
      where.productId = params.productId;
      where.batchNumber = params.batchNumber.trim();
    } else {
      throw new BadRequestException('Debe proporcionar batchId o productId y batchNumber');
    }

    const batch = await this.prisma.productBatch.findFirst({
      where,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            barcode: true,
            unit: true,
            cost: true,
            price: true,
          },
        },
        purchaseItem: {
          include: {
            purchase: {
              select: {
                id: true,
                invoiceNumber: true,
                purchaseDate: true,
                createdAt: true,
                supplier: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException('Lote no encontrado');
    }

    const saleItemBatches: any[] = await this.prisma.saleItemBatch.findMany({
      where: { batchId: batch.id },
      include: {
        saleItem: {
          select: {
            id: true,
            productName: true,
            unitPrice: true,
            sale: {
              select: {
                id: true,
                invoiceNumber: true,
                createdAt: true,
                status: true,
                cashier: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const movements = await this.prisma.stockMovement.findMany({
      where: { businessId, batchId: batch.id },
      include: {
        user: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    let totalSold = 0;
    const salesList = [];
    for (const sib of saleItemBatches) {
      const q = Number(sib.quantity);
      totalSold += q;
      salesList.push({
        saleId: sib.saleItem?.sale?.id,
        invoiceNumber: sib.saleItem?.sale?.invoiceNumber,
        date: sib.saleItem?.sale?.createdAt || sib.createdAt,
        quantity: q,
        unitPrice: sib.saleItem?.unitPrice,
        cashierName: sib.saleItem?.sale?.cashier?.name || null,
        status: sib.saleItem?.sale?.status,
      });
    }
    totalSold = round3(totalSold);

    let totalReturned = 0;
    let totalExpired = 0;
    let totalAdjusted = 0;

    for (const m of movements) {
      const mq = Number(m.quantity);
      if (m.type === 'DEVOLUCION') {
        totalReturned += mq;
      } else if (
        m.type === 'AJUSTE' &&
        (m.concept.toLowerCase().includes('expired') || m.concept.toLowerCase().includes('vencid'))
      ) {
        totalExpired += Math.abs(mq);
      } else if (m.type === 'AJUSTE') {
        totalAdjusted += mq;
      }
    }
    totalReturned = round3(totalReturned);
    totalExpired = round3(totalExpired);
    totalAdjusted = round3(totalAdjusted);

    const currentBalance = round3(Number(batch.quantity));

    let totalReceived = batch.purchaseItem
      ? round3(Number(batch.purchaseItem.quantity))
      : round3(currentBalance + totalSold - totalReturned + totalExpired - totalAdjusted);

    if (totalReceived < 0) {
      totalReceived = currentBalance;
    }

    const balanceDiff = round3(
      currentBalance - (totalReceived - totalSold + totalReturned - totalExpired + totalAdjusted),
    );
    if (balanceDiff !== 0) {
      totalReceived = round3(totalReceived + balanceDiff);
    }

    return {
      batch: {
        id: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        currentQuantity: currentBalance,
        cost: batch.cost != null ? Number(batch.cost) : null,
        createdAt: batch.createdAt,
        product: batch.product,
        purchase: batch.purchaseItem?.purchase
          ? {
              id: batch.purchaseItem.purchase.id,
              invoiceNumber: batch.purchaseItem.purchase.invoiceNumber,
              purchaseDate:
                batch.purchaseItem.purchase.purchaseDate || batch.purchaseItem.purchase.createdAt,
              supplierName: batch.purchaseItem.purchase.supplier?.name || null,
            }
          : null,
      },
      totals: {
        totalReceived,
        totalSold,
        totalReturned,
        totalExpired,
        totalAdjusted,
        currentBalance,
      },
      sales: salesList,
      movements: movements.map((m) => ({
        id: m.id,
        date: m.createdAt,
        type: m.type,
        quantity: Number(m.quantity),
        stockBefore: Number(m.stockBefore),
        stockAfter: Number(m.stockAfter),
        concept: m.concept,
        reference: m.reference,
        userName: m.user?.name || null,
      })),
    };
  }

  /**
   * Ventas del periodo agrupadas por producto y lote.
   */
  async getSalesByBatch(
    businessId: string,
    query: {
      from?: string;
      to?: string;
      productId?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { tracksBatches: true },
    });
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));

    if (!business?.tracksBatches) {
      return {
        data: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      };
    }

    const conditions: string[] = [`s."businessId" = $1`, `s."status" = 'COMPLETED'`];
    const params: any[] = [businessId];
    let pIdx = 2;

    if (query.from) {
      const fromDate = new Date(query.from);
      fromDate.setHours(0, 0, 0, 0);
      conditions.push(`s."createdAt" >= $${pIdx++}`);
      params.push(fromDate);
    }

    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      conditions.push(`s."createdAt" <= $${pIdx++}`);
      params.push(toDate);
    }

    if (query.productId) {
      conditions.push(`b."productId" = $${pIdx++}`);
      params.push(query.productId);
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `
      SELECT COUNT(DISTINCT (b."productId", sib."batchId"))::int as total
      FROM "pos_sale_item_batches" sib
      JOIN "pos_sale_items" si ON si.id = sib."saleItemId"
      JOIN "pos_sales" s ON s.id = si."saleId"
      JOIN "pos_product_batches" b ON b.id = sib."batchId"
      WHERE ${whereClause};
    `;
    const countRes: any[] = await this.prisma.$queryRawUnsafe(countSql, ...params);
    const total = Number(countRes[0]?.total ?? 0);
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;

    const dataSql = `
      SELECT
        p.id as "productId",
        p.name as "productName",
        p.sku as "productSku",
        b.id as "batchId",
        b."batchNumber" as "batchNumber",
        b."expiryDate" as "expiryDate",
        SUM(sib.quantity)::numeric as "totalQuantitySold",
        SUM(sib.quantity * si."unitPrice")::numeric as "totalRevenue",
        COUNT(DISTINCT s.id)::int as "salesCount"
      FROM "pos_sale_item_batches" sib
      JOIN "pos_sale_items" si ON si.id = sib."saleItemId"
      JOIN "pos_sales" s ON s.id = si."saleId"
      JOIN "pos_product_batches" b ON b.id = sib."batchId"
      JOIN "pos_products" p ON p.id = b."productId"
      WHERE ${whereClause}
      GROUP BY p.id, p.name, p.sku, b.id, b."batchNumber", b."expiryDate"
      ORDER BY "totalQuantitySold" DESC
      LIMIT ${limit} OFFSET ${offset};
    `;

    const rawRows: any[] = await this.prisma.$queryRawUnsafe(dataSql, ...params);
    const data = rawRows.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      productSku: r.productSku || null,
      batchId: r.batchId,
      batchNumber: r.batchNumber,
      expiryDate: r.expiryDate || null,
      totalQuantitySold: round3(Number(r.totalQuantitySold ?? 0)),
      totalRevenue: round2(Number(r.totalRevenue ?? 0)),
      salesCount: Number(r.salesCount ?? 0),
    }));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Mermas por vencimiento (ajustes EXPIRED) con pérdida calculada.
   */
  async getExpiredLoss(
    businessId: string,
    query: { from?: string; to?: string },
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { tracksBatches: true },
    });
    if (!business?.tracksBatches) {
      return {
        data: [],
        totals: { totalQuantityExpired: 0, totalLossAmount: 0 },
      };
    }

    const where: any = {
      businessId,
      type: InventoryAdjustmentType.EXPIRED,
    };

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) {
        const fromDate = new Date(query.from);
        fromDate.setHours(0, 0, 0, 0);
        where.createdAt.gte = fromDate;
      }
      if (query.to) {
        const toDate = new Date(query.to);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    const adjustments = await this.prisma.inventoryAdjustment.findMany({
      where,
      include: {
        product: { select: { id: true, name: true, sku: true, barcode: true, cost: true } },
        user: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (adjustments.length === 0) {
      return {
        data: [],
        totals: { totalQuantityExpired: 0, totalLossAmount: 0 },
      };
    }

    const adjIds = adjustments.map((a) => a.id);
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        businessId,
        reference: { in: adjIds },
      },
      include: {
        batch: { select: { id: true, batchNumber: true, expiryDate: true, cost: true } },
      },
    });

    const movementByRef = new Map(movements.map((m) => [m.reference, m]));

    let totalQuantityExpired = 0;
    let totalLossAmount = 0;

    const data = adjustments.map((adj) => {
      const mov = movementByRef.get(adj.id);
      const batch = mov?.batch;
      const qty = round3(Math.abs(Number(adj.qtyDelta)));
      const unitCost = Number(batch?.cost ?? adj.costAtTime ?? adj.product.cost ?? 0);
      const lossAmount = round2(qty * unitCost);

      totalQuantityExpired += qty;
      totalLossAmount += lossAmount;

      return {
        id: adj.id,
        date: adj.createdAt,
        productId: adj.product.id,
        productName: adj.product.name,
        productSku: adj.product.sku || null,
        batchId: batch?.id || null,
        batchNumber: batch?.batchNumber || null,
        expiryDate: batch?.expiryDate || null,
        quantity: qty,
        unitCost,
        lossAmount,
        reason: adj.reason,
        notes: adj.notes,
        userName: adj.user?.name || null,
      };
    });

    return {
      data,
      totals: {
        totalQuantityExpired: round3(totalQuantityExpired),
        totalLossAmount: round2(totalLossAmount),
      },
    };
  }
}
