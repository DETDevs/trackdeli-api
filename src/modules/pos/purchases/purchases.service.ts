import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import {
  Prisma,
  PurchaseStatus,
  StockMovementType,
  UserRole,
  BusinessProductType,
  PayableAccountStatus,
  PosPaymentMethod,
  MovementType,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PoliciesService } from '../policies/policies.service';
import { AuditService } from '../audit/audit.service';
import { BusinessProductsService } from '../../business-products/business-products.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { VoidPurchaseDto } from './dto/void-purchase.dto';
import { buildBusinessDateRange } from '../../../common/utils/date.util';
import { validateProductQuantity, round3 } from '../products/product-unit.util';

import { BatchesService } from '../batches/batches.service';

@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policiesService: PoliciesService,
    private readonly auditService: AuditService,
    private readonly businessProductsService: BusinessProductsService,
    private readonly batchesService: BatchesService,
  ) {}

  async create(dto: CreatePurchaseDto, businessId: string, userId: string) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PURCHASE_ITEMS_REQUIRED',
        message: {
          code: 'PURCHASE_ITEMS_REQUIRED',
          message: 'La compra debe contener al menos un ítem.',
        },
      });
    }

    const isCredit = dto.paymentCondition === 'CREDITO';
    if (isCredit) {
      if (!dto.supplierId) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'SUPPLIER_REQUIRED_FOR_CREDIT',
          message: 'Debe especificar un proveedor para registrar una compra a crédito.',
        });
      }
      if (!dto.dueDate) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'DUE_DATE_REQUIRED_FOR_CREDIT',
          message: 'La fecha de vencimiento es obligatoria para compras a crédito.',
        });
      }
      const dueDateParsed = new Date(dto.dueDate);
      if (isNaN(dueDateParsed.getTime())) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_DUE_DATE',
          message: 'La fecha de vencimiento no es válida.',
        });
      }

      const hasFinanzas = await this.businessProductsService.isActive(
        businessId,
        BusinessProductType.CARTERA_COBRO,
      );
      if (!hasFinanzas) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'FINANZAS_MODULE_REQUIRED',
          message: 'Este negocio no tiene el módulo de Finanzas contratado para realizar compras a crédito.',
        });
      }
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
          message: {
            code: 'SUPPLIER_NOT_FOUND',
            message: 'Proveedor no encontrado en este negocio.',
          },
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

    let downPaymentDec = new Prisma.Decimal(0);
    const downPaymentMethod = dto.downPaymentMethod || PosPaymentMethod.EFECTIVO;
    const deductFromShift = Boolean(dto.deductFromCurrentShift);

    if (isCredit && dto.downPayment !== undefined && dto.downPayment !== null) {
      downPaymentDec = new Prisma.Decimal(dto.downPayment);
      if (downPaymentDec.isNaN() || downPaymentDec.lte(0)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_DOWN_PAYMENT',
          message: 'El anticipo debe ser mayor a 0.',
        });
      }
      if (downPaymentDec.gte(calculatedTotalDec)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_DOWN_PAYMENT',
          message: 'El anticipo debe ser menor al total de la compra. Si abona el total completo, use condición CONTADO.',
        });
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let openShift: any = null;
      if (isCredit && deductFromShift && downPaymentDec.gt(0) && downPaymentMethod === PosPaymentMethod.EFECTIVO) {
        openShift = await tx.cashRegister.findFirst({
          where: { businessId, cashierId: userId, status: 'OPEN' },
        });
        if (!openShift) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'NO_OPEN_CASH_SHIFT',
            message: 'No hay un turno de caja abierto para registrar la salida de efectivo del anticipo.',
          });
        }
      }

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

      const business = await tx.business.findUnique({
        where: { id: businessId },
        select: { id: true, tracksBatches: true },
      });

      const assignedBatchesByProduct = new Map<string, Set<string>>();

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
            message: {
              code: 'PRODUCT_NOT_FOUND',
              message: `Producto con ID "${item.productId}" no encontrado.`,
            },
          });
        }

        const isTracked = this.batchesService.isTracked(business, product);

        let productAssigned = assignedBatchesByProduct.get(product.id);
        if (!productAssigned) {
          productAssigned = new Set<string>();
          assignedBatchesByProduct.set(product.id, productAssigned);
        }

        let finalLotNumber: string | null = null;
        let isAutoGenerated = false;

        const rawLot = (item.lotNumber || (item as any).batchNumber || '').trim();

        if (isTracked) {
          if (!item.expiryDate || (typeof item.expiryDate === 'string' && !item.expiryDate.trim())) {
            throw new BadRequestException(
              `El producto "${product.name}" tiene control de lotes activado; la fecha de vencimiento es obligatoria.`,
            );
          }

          if (rawLot) {
            finalLotNumber = rawLot;
            productAssigned.add(rawLot);
          } else {
            isAutoGenerated = true;
            const basePrefix = this.generateBatchBasePrefix(dto.purchaseDate || purchase.purchaseDate);
            finalLotNumber = await this.resolveAutoBatchNumber(
              tx,
              businessId,
              product.id,
              basePrefix,
              productAssigned,
            );
          }
        } else {
          finalLotNumber = rawLot || null;
        }

        const validQty = validateProductQuantity(product.unit, item.quantity, product.name);
        const unitCostDec = new Prisma.Decimal(item.unitCost);
        const itemSubtotal = new Prisma.Decimal(validQty).times(unitCostDec);
        const createdPurchaseItem = await tx.purchaseItem.create({
          data: {
            purchaseId: purchase.id,
            productId: product.id,
            quantity: validQty,
            unitCost: unitCostDec,
            subtotal: itemSubtotal,
            lotNumber: finalLotNumber,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
          },
        });

        const stockBefore = Number(product.stock);
        const stockAfter = round3(stockBefore + validQty);
        const oldCostDec = product.cost != null ? new Prisma.Decimal(product.cost.toString()) : null;
        const newCostNum = Number(unitCostDec);

        let createdBatchId: string | null = null;
        if (product.trackStock) {
          if (isTracked) {
            let batch;
            let currentLot = finalLotNumber!;
            let autoSuffix = 1;
            while (true) {
              try {
                batch = await this.batchesService.receive(tx, {
                  businessId,
                  productId: product.id,
                  batchNumber: currentLot,
                  expiryDate: item.expiryDate,
                  qty: validQty,
                  cost: newCostNum,
                  purchaseItemId: createdPurchaseItem.id,
                });
                break;
              } catch (err: any) {
                if (isAutoGenerated && err?.code === 'P2002' && autoSuffix < 100) {
                  autoSuffix++;
                  const basePrefix = this.generateBatchBasePrefix(dto.purchaseDate || purchase.purchaseDate);
                  currentLot = `${basePrefix}-${autoSuffix}`;
                  productAssigned.add(currentLot);
                  await tx.purchaseItem.update({
                    where: { id: createdPurchaseItem.id },
                    data: { lotNumber: currentLot },
                  });
                  continue;
                }
                throw err;
              }
            }
            createdBatchId = batch.id;
            await tx.product.update({
              where: { id: product.id },
              data: { cost: newCostNum },
            });
          } else {
            await tx.product.update({
              where: { id: product.id },
              data: {
                stock: { increment: validQty },
                cost: newCostNum,
              },
            });
          }

          await tx.stockMovement.create({
            data: {
              businessId,
              productId: product.id,
              userId,
              type: StockMovementType.COMPRA,
              quantity: validQty,
              stockBefore,
              stockAfter,
              cost: unitCostDec,
              concept: `Compra factura ${trimmedInvoice || 'S/N'}`,
              reference: purchase.id,
              batchId: createdBatchId,
            },
          });
        } else {
          await tx.product.update({
            where: { id: product.id },
            data: { cost: newCostNum },
          });
        }

        await tx.productCostHistory.create({
          data: {
            businessId,
            productId: product.id,
            oldCost: oldCostDec,
            newCost: unitCostDec,
            purchaseId: purchase.id,
            reason: `Compra factura ${trimmedInvoice || 'S/N'}`,
          },
        });
      }

      // If credit purchase, create PayableAccount and optional down payment
      if (isCredit) {
        const initialBalance = calculatedTotalDec.minus(downPaymentDec);
        const payableStatus = downPaymentDec.gt(0)
          ? PayableAccountStatus.PARTIALLY_PAID
          : PayableAccountStatus.PENDING;

        const payable = await tx.payableAccount.create({
          data: {
            businessId,
            purchaseId: purchase.id,
            supplierId: dto.supplierId!,
            originalAmount: calculatedTotalDec,
            balance: initialBalance,
            status: payableStatus,
            dueDate: new Date(dto.dueDate!),
            notes: dto.notes ? dto.notes.trim() : null,
          },
        });

        if (downPaymentDec.gt(0)) {
          let cashMovementId: string | null = null;
          if (deductFromShift && downPaymentMethod === PosPaymentMethod.EFECTIVO && openShift) {
            const cm = await tx.cashMovement.create({
              data: {
                businessId,
                cashRegisterId: openShift.id,
                userId,
                type: MovementType.SALIDA,
                amount: downPaymentDec,
                concept: `Anticipo compra factura ${trimmedInvoice || purchase.id}`,
                currency: 'NIO',
                exchangeRate: new Prisma.Decimal(1),
                amountBase: downPaymentDec,
              },
            });
            cashMovementId = cm.id;
          }

          await tx.supplierPayment.create({
            data: {
              payableAccountId: payable.id,
              amount: downPaymentDec,
              paymentMethod: downPaymentMethod,
              paidAt: new Date(),
              notes: 'Anticipo compra',
              paidByUserId: userId,
              cashMovementId,
            },
          });
        }
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
            isCredit,
            downPayment: Number(downPaymentDec),
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
          payableAccount: {
            include: {
              payments: {
                include: {
                  paidByUser: { select: { id: true, name: true } },
                },
              },
            },
          },
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
        message: {
          code: 'VOID_REASON_REQUIRED',
          message: 'El motivo de anulación es obligatorio.',
        },
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
          message: {
            code: 'PURCHASE_NOT_FOUND',
            message: 'Compra no encontrada.',
          },
        });
      }

      if (purchase.status === PurchaseStatus.VOIDED) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'PURCHASE_ALREADY_VOIDED',
          message: {
            code: 'PURCHASE_ALREADY_VOIDED',
            message: 'Esta compra ya fue anulada previamente.',
          },
        });
      }

      // Check if purchase has an associated payable account
      const payable = await tx.payableAccount.findUnique({
        where: { purchaseId: id },
        include: {
          payments: {
            where: { isVoided: false },
          },
        },
      });

      if (payable) {
        if (payable.payments.length > 0) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            error: 'Unprocessable Entity',
            code: 'PURCHASE_HAS_ACTIVE_PAYMENTS',
            message: 'No se puede anular una compra con abonos activos en cuentas por pagar. Anule los abonos primero.',
          });
        }

        await tx.payableAccount.update({
          where: { id: payable.id },
          data: {
            status: PayableAccountStatus.CANCELLED,
          },
        });
      }

      // Check negative stock constraints for tracked items
      for (const item of purchase.items) {
        await tx.$queryRaw`SELECT id FROM pos_products WHERE id = ${item.productId} FOR UPDATE`;
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });

        if (product.trackStock) {
          const qty = round3(Number(item.quantity));
          const currentStock = Number(product.stock);
          const resultingStock = round3(currentStock - qty);
          if (resultingStock < 0 && !policies.allowNegativeStock) {
            throw new UnprocessableEntityException({
              statusCode: 422,
              error: 'Unprocessable Entity',
              code: 'PURCHASE_VOID_INSUFFICIENT_STOCK',
              message: {
                code: 'PURCHASE_VOID_INSUFFICIENT_STOCK',
                message: `No se puede anular la compra: el stock de "${product.name}" quedaría en ${resultingStock} (disponible actual: ${currentStock}, a revertir: ${qty}).`,
                productId: product.id,
                productName: product.name,
                currentStock,
                revertQuantity: qty,
                resultingStock,
              },
            });
          }
        }
      }

      const business = await tx.business.findUnique({
        where: { id: purchase.businessId },
        select: { id: true, tracksBatches: true },
      });

      // Revert stock and handle cost history
      for (const item of purchase.items) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
        const qty = round3(Number(item.quantity));
        const stockBefore = Number(product.stock);
        const stockAfter = round3(stockBefore - qty);
        const isTracked = this.batchesService.isTracked(business, product);

        let batchIdForMovement: string | null = null;

        if (product.trackStock) {
          if (isTracked) {
            const batch = (await tx.productBatch.findFirst({
              where: { businessId: purchase.businessId, productId: product.id, purchaseItemId: item.id },
            })) || (item.lotNumber ? await tx.productBatch.findFirst({
              where: { businessId: purchase.businessId, productId: product.id, batchNumber: item.lotNumber },
            }) : null);

            if (batch) {
              batchIdForMovement = batch.id;
              if (Number(batch.quantity) < qty) {
                throw new BadRequestException(
                  `No se puede anular la compra: el lote "${batch.batchNumber}" ya tiene unidades vendidas (disponible en lote: ${batch.quantity}, comprado: ${qty})`,
                );
              }
              await tx.productBatch.update({
                where: { id: batch.id },
                data: { quantity: { decrement: qty } },
              });
              await this.batchesService.syncProductStock(tx, product.id);
            } else {
              await this.batchesService.adjust(tx, {
                businessId: purchase.businessId,
                productId: product.id,
                delta: -qty,
              });
            }
          } else {
            await tx.product.update({
              where: { id: product.id },
              data: { stock: { decrement: qty } },
            });
          }

          await tx.stockMovement.create({
            data: {
              businessId,
              productId: product.id,
              userId,
              type: StockMovementType.AJUSTE,
              quantity: -qty,
              stockBefore,
              stockAfter,
              cost: product.cost != null ? new Prisma.Decimal(product.cost.toString()) : null,
              concept: `Anulación compra ${purchase.invoiceNumber || purchase.id}: ${dto.reason.trim()}`,
              reference: purchase.id,
              batchId: batchIdForMovement,
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
            data: { cost: Number(lastCostHistory.oldCost) },
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
          payableAccount: {
            include: {
              payments: {
                include: {
                  paidByUser: { select: { id: true, name: true } },
                },
              },
            },
          },
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
      where.purchaseDate = buildBusinessDateRange(filters.from, filters.to);
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
          payableAccount: {
            include: {
              payments: {
                include: {
                  paidByUser: { select: { id: true, name: true } },
                },
              },
            },
          },
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
        payableAccount: {
          include: {
            payments: {
              include: {
                paidByUser: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    if (!purchase) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'PURCHASE_NOT_FOUND',
        message: {
          code: 'PURCHASE_NOT_FOUND',
          message: 'Compra no encontrada.',
        },
      });
    }

    return this.formatPurchase(purchase);
  }

  private generateBatchBasePrefix(purchaseDate: Date | string | null | undefined): string {
    if (typeof purchaseDate === 'string' && purchaseDate.trim()) {
      const trimmed = purchaseDate.trim();
      const matchYMD = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (matchYMD) {
        const yy = matchYMD[1].slice(2);
        const mm = matchYMD[2].padStart(2, '0');
        const dd = matchYMD[3].padStart(2, '0');
        return `L-${yy}${mm}${dd}`;
      }
      const matchDMY = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (matchDMY) {
        const yy = matchDMY[3].slice(2);
        const mm = matchDMY[2].padStart(2, '0');
        const dd = matchDMY[1].padStart(2, '0');
        return `L-${yy}${mm}${dd}`;
      }
    }

    const d = purchaseDate instanceof Date ? purchaseDate : (purchaseDate ? new Date(purchaseDate) : new Date());
    const validDate = isNaN(d.getTime()) ? new Date() : d;
    const iso = validDate.toISOString().slice(0, 10);
    const yy = iso.slice(2, 4);
    const mm = iso.slice(5, 7);
    const dd = iso.slice(8, 10);
    return `L-${yy}${mm}${dd}`;
  }

  private async resolveAutoBatchNumber(
    tx: Prisma.TransactionClient,
    businessId: string,
    productId: string,
    basePrefix: string,
    assignedInPurchase: Set<string>,
  ): Promise<string> {
    const existingBatches = await tx.productBatch.findMany({
      where: {
        businessId,
        productId,
        batchNumber: {
          startsWith: basePrefix,
        },
      },
      select: { batchNumber: true },
    });

    const takenNumbers = new Set<string>(existingBatches.map((b) => b.batchNumber));
    for (const num of assignedInPurchase) {
      takenNumbers.add(num);
    }

    if (!takenNumbers.has(basePrefix)) {
      assignedInPurchase.add(basePrefix);
      return basePrefix;
    }

    let suffix = 2;
    while (true) {
      const candidate = `${basePrefix}-${suffix}`;
      if (!takenNumbers.has(candidate)) {
        assignedInPurchase.add(candidate);
        return candidate;
      }
      suffix++;
    }
  }

  private formatPurchase(purchase: any) {
    return {
      ...purchase,
      total: Number(new Prisma.Decimal(purchase.total != null ? purchase.total.toString() : 0).toDecimalPlaces(2)),
      items: (purchase.items || []).map((i: any) => ({
        ...i,
        unitCost: Number(new Prisma.Decimal(i.unitCost != null ? i.unitCost.toString() : 0).toDecimalPlaces(2)),
        subtotal: Number(new Prisma.Decimal(i.subtotal != null ? i.subtotal.toString() : 0).toDecimalPlaces(2)),
        batchNumber: i.lotNumber ?? null,
      })),
      payableAccount: purchase.payableAccount
        ? {
            ...purchase.payableAccount,
            originalAmount: Number(new Prisma.Decimal(purchase.payableAccount.originalAmount != null ? purchase.payableAccount.originalAmount.toString() : 0).toDecimalPlaces(2)),
            balance: Number(new Prisma.Decimal(purchase.payableAccount.balance != null ? purchase.payableAccount.balance.toString() : 0).toDecimalPlaces(2)),
            payments: (purchase.payableAccount.payments || []).map((p: any) => ({
              ...p,
              amount: Number(new Prisma.Decimal(p.amount != null ? p.amount.toString() : 0).toDecimalPlaces(2)),
              paidBy: p.paidByUser,
            })),
          }
        : null,
    };
  }
}
