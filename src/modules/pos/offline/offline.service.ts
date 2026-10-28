import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { TrackingGateway } from "../../tracking/tracking.gateway";
import {
  RegisterTerminalDto,
  UpdateTerminalStatusDto,
  SyncOfflineBatchDto,
  ResolveDiscrepancyDto,
} from "./dto/offline.dto";
import { validateProductQuantity, round3 } from "../products/product-unit.util";

import { BatchesService } from "../batches/batches.service";
import { calculateSaleTotals, RawSaleItemCalculationInput } from "../sales/utils/sale-calculation.util";

@Injectable()
export class OfflineService {
  private readonly logger = new Logger(OfflineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
    private readonly batchesService: BatchesService,
  ) { }

  async checkEligibility(
    businessId: string,
    deviceIdentifier?: string,
    pendingCount?: number,
  ) {

    if (deviceIdentifier) {
      try {
        const terminal = await this.prisma.posTerminal.findUnique({
          where: { businessId_deviceIdentifier: { businessId, deviceIdentifier } },
        });

        if (terminal) {
          const updateData: any = { lastSeenAt: new Date() };
          if (pendingCount !== undefined) {
            updateData.pendingSalesCount = Math.max(0, pendingCount);
            updateData.hasPendingOfflineSales = pendingCount > 0;
          }
          await this.prisma.posTerminal.update({
            where: { id: terminal.id },
            data: updateData,
          });
        }
      } catch (err: any) {
        this.logger.warn(`[checkEligibility] Error actualizando terminal ${deviceIdentifier}: ${err.message}`);
      }
    }

    const activeTerminals = await this.prisma.posTerminal.findMany({
      where: { businessId, isActive: true },
      select: { id: true, name: true, deviceIdentifier: true, hasPendingOfflineSales: true, pendingSalesCount: true },
    });

    const activeTerminalsCount = activeTerminals.length;

    if (activeTerminalsCount > 1) {
      return {
        eligible: false,
        reason: "MULTIPLE_POS_TERMINALS",
        activeTerminalsCount,
        terminals: activeTerminals.map((t) => ({ id: t.id, name: t.name })),
      };
    }

    return {
      eligible: true,
      activeTerminalsCount,
      terminal: activeTerminals[0] || null,
    };
  }

  async registerTerminal(businessId: string, dto: RegisterTerminalDto) {
    this.logger.log(`[registerTerminal] businessId=${businessId} deviceIdentifier=${dto.deviceIdentifier}`);

    const existingTerminal = await this.prisma.posTerminal.findUnique({
      where: { businessId_deviceIdentifier: { businessId, deviceIdentifier: dto.deviceIdentifier } },
    });

    if (existingTerminal && existingTerminal.isActive) {
      return this.prisma.posTerminal.update({
        where: { id: existingTerminal.id },
        data: {
          name: dto.name || existingTerminal.name,
          lastSeenAt: new Date(),
        },
      });
    }

    const willBeActive = dto.isActive !== undefined ? dto.isActive : true;
    if (willBeActive) {
      await this.validateNoPendingOfflineSales(businessId, existingTerminal?.id);
    }

    const count = await this.prisma.posTerminal.count({ where: { businessId } });
    const defaultName = `Caja ${count + 1}`;

    return this.prisma.posTerminal.upsert({
      where: { businessId_deviceIdentifier: { businessId, deviceIdentifier: dto.deviceIdentifier } },
      create: {
        businessId,
        deviceIdentifier: dto.deviceIdentifier,
        name: dto.name || defaultName,
        isActive: willBeActive,
        lastSeenAt: new Date(),
      },
      update: {
        name: dto.name || undefined,
        isActive: willBeActive,
        lastSeenAt: new Date(),
      },
    });
  }

  async getTerminals(businessId: string) {
    return this.prisma.posTerminal.findMany({
      where: { businessId },
      orderBy: { createdAt: "asc" },
    });
  }

  async updateTerminal(id: string, businessId: string, dto: UpdateTerminalStatusDto) {
    const terminal = await this.prisma.posTerminal.findFirst({
      where: { id, businessId },
    });
    if (!terminal) throw new NotFoundException("Terminal no encontrada");

    if (dto.isActive === true && !terminal.isActive) {
      await this.validateNoPendingOfflineSales(businessId, id);
    }

    return this.prisma.posTerminal.update({
      where: { id },
      data: {
        ...dto,
        lastSeenAt: new Date(),
      },
    });
  }

  private async validateNoPendingOfflineSales(businessId: string, excludeTerminalId?: string) {
    const where: any = {
      businessId,
      isActive: true,
      OR: [
        { hasPendingOfflineSales: true },
        { pendingSalesCount: { gt: 0 } },
      ],
    };
    if (excludeTerminalId) {
      where.id = { not: excludeTerminalId };
    }

    const terminalWithPending = await this.prisma.posTerminal.findFirst({
      where,
      select: { name: true, pendingSalesCount: true },
    });

    if (terminalWithPending) {
      throw new BadRequestException(
        `No se puede activar un segundo POS mientras existan ventas sin sincronizar en "${terminalWithPending.name}". Sincronice primero.`
      );
    }
  }

  async syncOfflineSales(businessId: string, cashierId: string, dto: SyncOfflineBatchDto) {
    this.logger.log(
      `[syncOfflineSales] Inicio de sync: businessId=${businessId} device=${dto.deviceIdentifier} totalVentas=${dto.sales.length}`
    );

    const terminal = await this.prisma.posTerminal.findUnique({
      where: { businessId_deviceIdentifier: { businessId, deviceIdentifier: dto.deviceIdentifier } },
    });

    const results: any[] = [];

    for (const saleDto of dto.sales) {
      try {

        const existingSale = await this.prisma.sale.findFirst({
          where: {
            businessId,
            clientGeneratedId: saleDto.clientGeneratedId,
          },
          select: { id: true, invoiceNumber: true, total: true, createdAt: true },
        });

        if (existingSale) {
          results.push({
            clientGeneratedId: saleDto.clientGeneratedId,
            status: "ALREADY_SYNCED",
            saleId: existingSale.id,
            invoiceNumber: existingSale.invoiceNumber,
            total: existingSale.total,
            discrepancies: [],
          });
          continue;
        }

        const syncResult = await this.prisma.$transaction(async (tx) => {
          const business = await tx.business.findUnique({
            where: { id: businessId },
            select: {
              invoicePrefix: true,
              invoiceCounter: true,
              taxRate: true,
              taxEnabled: true,
              taxIncluded: true,
              currency: true,
              tracksBatches: true,
              useListPrice: true,
              defaultMarkupPct: true,
              autoUpdatePriceOnPurchase: true,
            },
          });
          if (!business) throw new NotFoundException("Negocio no encontrado");

          const invoiceNumber = `${business.invoicePrefix}-${String(business.invoiceCounter).padStart(4, "0")}`;
          await tx.business.update({
            where: { id: businessId },
            data: { invoiceCounter: { increment: 1 } },
          });

          const rawItemsForCalc: RawSaleItemCalculationInput[] = [];
          const discrepancies: any[] = [];
          const pendingAllocations: Array<{ productId: string; allocations: any[] }> = [];

          for (const item of saleDto.items) {
            let product: any = null;
            if (item.productId) {
              product = await tx.product.findFirst({
                where: { id: item.productId, businessId },
                include: {
                  recipeComponents: {
                    include: {
                      componentProduct: true,
                    },
                  },
                },
              });

              if (product) {
                validateProductQuantity(product.unit, item.quantity, product.name);
              }
            }

            if (product && product.isRecipe && product.recipeComponents && product.recipeComponents.length > 0) {
              // Producto con receta: descontar cada componente
              for (const comp of product.recipeComponents) {
                const compProd = comp.componentProduct;
                if (compProd && compProd.trackStock) {
                  const deductQty = round3(Number(item.quantity) * Number(comp.quantity));
                  const expectedStock = Number(compProd.stock);
                  const resultingStock = round3(expectedStock - deductQty);

                  const isCompTracked = this.batchesService.isTracked(business, compProd);
                  if (isCompTracked) {
                    const allocRes = await this.batchesService.allocateOffline(tx, {
                      businessId,
                      productId: compProd.id,
                      qty: deductQty,
                    });

                    if (allocRes.allocations.length > 0) {
                      pendingAllocations.push({ productId: product.id, allocations: allocRes.allocations });
                    }

                    for (const a of allocRes.allocations) {
                      const concept = a.isExpired
                        ? `Consumo receta: ${product.name} (Lote vencido: ${a.batchNumber})`
                        : `Consumo receta: ${product.name} (Lote: ${a.batchNumber})`;

                      await tx.stockMovement.create({
                        data: {
                          businessId,
                          productId: compProd.id,
                          userId: cashierId,
                          type: "VENTA",
                          quantity: -a.quantity,
                          stockBefore: expectedStock,
                          stockAfter: Math.max(0, round3(expectedStock - a.quantity)),
                          concept,
                          reference: saleDto.clientGeneratedId,
                          batchId: a.batchId,
                        },
                      });
                    }

                    if (allocRes.unallocatedQty > 0) {
                      await tx.stockMovement.create({
                        data: {
                          businessId,
                          productId: compProd.id,
                          userId: cashierId,
                          type: "VENTA",
                          quantity: -allocRes.unallocatedQty,
                          stockBefore: expectedStock,
                          stockAfter: 0,
                          concept: `Consumo receta: ${product.name} (Sin lote asignado por stock insuficiente)`,
                          reference: saleDto.clientGeneratedId,
                          batchId: null,
                        },
                      });

                      discrepancies.push({
                        productId: compProd.id,
                        productName: compProd.name || product.name,
                        expectedStock: round3(deductQty - allocRes.unallocatedQty),
                        resultingStock: 0,
                        message: `Insumo "${compProd.name}": ${allocRes.unallocatedQty} sin lote asignado por stock insuficiente`,
                        notes: `Venta offline ${invoiceNumber}: ${allocRes.unallocatedQty} unidad(es) de insumo "${compProd.name}" sin lote asignado por stock insuficiente`,
                      });
                    }

                    if (allocRes.hasExpiredAllocations) {
                      const expiredList = allocRes.allocations
                        .filter((a) => a.isExpired)
                        .map((a) => `${a.batchNumber} (${a.quantity})`)
                        .join(', ');
                      discrepancies.push({
                        productId: compProd.id,
                        productName: compProd.name || product.name,
                        expectedStock,
                        resultingStock: Math.max(0, round3(expectedStock - allocRes.totalAllocated)),
                        message: `Insumo "${compProd.name}": salida de lote(s) vencido(s): ${expiredList}`,
                        notes: `Venta offline ${invoiceNumber}: consumo de insumo "${compProd.name}" con salida de lote(s) vencido(s): ${expiredList}`,
                      });
                    }
                  } else {
                    if (expectedStock < deductQty) {
                      discrepancies.push({
                        productId: compProd.id,
                        productName: compProd.name || product.name,
                        expectedStock,
                        resultingStock,
                        message: `Consumo receta: stock insuficiente para "${compProd.name}"`,
                        notes: `Venta offline ${invoiceNumber}: consumo receta stock insuficiente para "${compProd.name}" (disponible: ${expectedStock}, requerido: ${deductQty})`,
                      });
                    }
                    await tx.product.update({
                      where: { id: compProd.id },
                      data: { stock: { decrement: deductQty } },
                    });

                    await tx.stockMovement.create({
                      data: {
                        businessId,
                        productId: compProd.id,
                        userId: cashierId,
                        type: "VENTA",
                        quantity: -deductQty,
                        stockBefore: expectedStock,
                        stockAfter: resultingStock,
                        concept: `Consumo receta: ${product.name}`,
                        reference: saleDto.clientGeneratedId,
                      },
                    });
                  }

                  // Actualizar en memoria para líneas posteriores
                  compProd.stock = resultingStock as any;
                }
              }
            } else if (product && product.trackStock) {
              const qty = round3(item.quantity);
              const expectedStock = Number(product.stock);
              const resultingStock = round3(expectedStock - qty);

              const isTracked = this.batchesService.isTracked(business, product);
              if (isTracked) {
                const allocRes = await this.batchesService.allocateOffline(tx, {
                  businessId,
                  productId: product.id,
                  qty,
                });

                if (allocRes.allocations.length > 0) {
                  pendingAllocations.push({ productId: product.id, allocations: allocRes.allocations });
                }

                for (const a of allocRes.allocations) {
                  const concept = a.isExpired
                    ? `Venta offline ${invoiceNumber} (Lote vencido: ${a.batchNumber})`
                    : `Venta offline ${invoiceNumber} (Lote: ${a.batchNumber})`;

                  await tx.stockMovement.create({
                    data: {
                      businessId,
                      productId: product.id,
                      userId: cashierId,
                      type: "VENTA",
                      quantity: -a.quantity,
                      stockBefore: expectedStock,
                      stockAfter: Math.max(0, round3(expectedStock - a.quantity)),
                      concept,
                      reference: saleDto.clientGeneratedId,
                      batchId: a.batchId,
                    },
                  });
                }

                if (allocRes.unallocatedQty > 0) {
                  await tx.stockMovement.create({
                    data: {
                      businessId,
                      productId: product.id,
                      userId: cashierId,
                      type: "VENTA",
                      quantity: -allocRes.unallocatedQty,
                      stockBefore: expectedStock,
                      stockAfter: 0,
                      concept: `Venta offline ${invoiceNumber} (Sin lote asignado por stock insuficiente)`,
                      reference: saleDto.clientGeneratedId,
                      batchId: null,
                    },
                  });

                  discrepancies.push({
                    productId: product.id,
                    productName: product.name,
                    expectedStock: round3(qty - allocRes.unallocatedQty),
                    resultingStock: 0,
                    message: `Producto "${product.name}": ${allocRes.unallocatedQty} sin lote asignado por stock insuficiente`,
                    notes: `Venta offline ${invoiceNumber}: ${allocRes.unallocatedQty} unidad(es) de "${product.name}" sin lote asignado por falta de stock`,
                  });
                }

                if (allocRes.hasExpiredAllocations) {
                  const expiredList = allocRes.allocations
                    .filter((a) => a.isExpired)
                    .map((a) => `${a.batchNumber} (${a.quantity})`)
                    .join(', ');
                  discrepancies.push({
                    productId: product.id,
                    productName: product.name,
                    expectedStock,
                    resultingStock: Math.max(0, round3(expectedStock - allocRes.totalAllocated)),
                    message: `Producto "${product.name}": salida de lote(s) vencido(s): ${expiredList}`,
                    notes: `Venta offline ${invoiceNumber}: salida de lote(s) vencido(s) para "${product.name}": ${expiredList}`,
                  });
                }
              } else {
                if (expectedStock < qty) {
                  discrepancies.push({
                    productId: product.id,
                    productName: product.name,
                    expectedStock,
                    resultingStock,
                    message: `Stock insuficiente para "${product.name}" (disponible: ${expectedStock}, solicitado: ${qty})`,
                    notes: `Venta offline ${invoiceNumber}: stock insuficiente (disponible: ${expectedStock}, requerido: ${qty})`,
                  });
                }
                await tx.product.update({
                  where: { id: product.id },
                  data: { stock: { decrement: qty } },
                });

                await tx.stockMovement.create({
                  data: {
                    businessId,
                    productId: product.id,
                    userId: cashierId,
                    type: "VENTA",
                    quantity: -qty,
                    stockBefore: expectedStock,
                    stockAfter: resultingStock,
                    concept: `Venta offline ${invoiceNumber}`,
                    reference: saleDto.clientGeneratedId,
                  },
                });
              }

              product.stock = resultingStock as any;
            }

            let listPrice: number | null = null;
            if (item.listPrice !== undefined && item.listPrice !== null) {
              listPrice = Number(item.listPrice);
            } else if (business.useListPrice && product?.listPrice != null) {
              listPrice = Number(product.listPrice);
            }

            let taxable: boolean | null | undefined = undefined;
            if (item.taxable !== undefined && item.taxable !== null) {
              taxable = Boolean(item.taxable);
            }

            rawItemsForCalc.push({
              productId: item.productId || null,
              productName: item.productName || product?.name || 'Producto',
              barcode: item.barcode || product?.barcode || null,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
              discount: item.discount || 0,
              listPrice,
              taxable,
            });
          }

          const calcResult = calculateSaleTotals(
            rawItemsForCalc,
            saleDto.discountAmount || 0,
            business,
          );

          const subtotal = calcResult.subtotal;
          const discountAmount = calcResult.discountAmount;
          const taxAmount = calcResult.taxAmount;
          const total = calcResult.total;
          const taxModel = calcResult.taxModel;
          const listPriceTotal = calcResult.listPriceTotal;
          const listDiscountTotal = calcResult.listDiscountTotal;
          const taxRate = calcResult.taxRate;
          const taxEnabled = calcResult.taxEnabled;
          const taxIncluded = calcResult.taxIncluded;

          const amountPaid = saleDto.amountPaid != null ? Number(saleDto.amountPaid) : total;
          const change = Math.max(0, amountPaid - total);

          const processedItems = calcResult.lines.map((l) => ({
            productId: l.productId,
            productName: l.productName,
            barcode: l.barcode,
            unitPrice: l.unitPrice,
            priceTier: l.priceTier,
            quantity: l.quantity,
            discount: l.discount,
            subtotal: l.subtotal,
            listPrice: l.listPrice,
            listPriceDiscount: l.listPriceDiscount,
            manualDiscountShare: l.manualDiscountShare,
            taxable: l.taxable,
            taxRate: l.taxRate,
            taxAmount: l.taxAmount,
          }));

          const occurredDate = new Date(saleDto.occurredAt);
          const validOccurredAt = isNaN(occurredDate.getTime()) ? new Date() : occurredDate;

          let cashRegisterId: string | null = null;
          let soldWithoutOpenShift = false;

          if (saleDto.cashRegisterId) {
            const explicitReg = await tx.cashRegister.findFirst({
              where: {
                id: saleDto.cashRegisterId,
                businessId,
                openedAt: { lte: validOccurredAt },
                OR: [
                  { closedAt: null },
                  { closedAt: { gte: validOccurredAt } },
                ],
              },
              select: { id: true },
            });
            if (explicitReg) {
              cashRegisterId = explicitReg.id;
            }
          }

          if (!cashRegisterId) {
            const coveringReg = await tx.cashRegister.findFirst({
              where: {
                businessId,
                openedAt: { lte: validOccurredAt },
                OR: [
                  { closedAt: null },
                  { closedAt: { gte: validOccurredAt } },
                ],
              },
              orderBy: { openedAt: "desc" },
              select: { id: true },
            });

            if (coveringReg) {
              cashRegisterId = coveringReg.id;
            } else {
              soldWithoutOpenShift = true;
              cashRegisterId = null;
            }
          }

          const isOfflineCredit = (saleDto.paymentMethod as any) === 'CREDITO' ||
            ((saleDto as any).payments && (saleDto as any).payments.some((p: any) => p.method === 'CREDITO'));

          if (isOfflineCredit) {
            const creditDiscMsg = `Venta a crédito offline sin cuenta por cobrar: registrar manualmente (Venta: ${invoiceNumber}, Monto: C$${total.toFixed(2)}, Cliente: ${saleDto.customerName || 'No indicado'}, Tel: ${saleDto.customerPhone || 'N/A'})`;
            const firstProdId = processedItems.find((pi) => pi.productId)?.productId;
            discrepancies.push({
              productId: firstProdId || null,
              productName: 'Crédito Offline',
              expectedStock: 0,
              resultingStock: 0,
              message: creditDiscMsg,
              notes: creditDiscMsg,
            });
          }

          const notesPrefix = soldWithoutOpenShift ? "[Offline][Sin Turno Abierto]" : "[Offline]";
          let finalNotes = saleDto.notes ? `${notesPrefix} ${saleDto.notes}` : notesPrefix;
          if (isOfflineCredit) {
            finalNotes += ' [Discrepancia: Venta a crédito offline sin cuenta por cobrar: registrar manualmente]';
          }

          let customerId: string | null = null;
          if (saleDto.customerId) {
            const existingCustomer = await tx.customer.findFirst({
              where: { id: saleDto.customerId, businessId },
              select: { id: true },
            });
            if (existingCustomer) {
              customerId = existingCustomer.id;
            }
          }

          const createdSale = await tx.sale.create({
            data: {
              businessId,
              cashRegisterId,
              cashierId,
              invoiceNumber,
              invoiceDate: validOccurredAt,
              occurredAt: validOccurredAt,
              syncedAt: new Date(),
              isOffline: true,
              soldWithoutOpenShift,
              hasNegativeStock: discrepancies.length > 0,
              clientGeneratedId: saleDto.clientGeneratedId,
              posTerminalId: terminal?.id || null,
              customerId,
              customerName: saleDto.customerName || null,
              customerPhone: saleDto.customerPhone || null,
              customerRuc: saleDto.customerRuc || null,
              items: { create: processedItems },
              payments: {
                create: [
                  {
                    method: saleDto.paymentMethod,
                    amount: total,
                    amountTendered: saleDto.amountPaid,
                    change,
                    reference: saleDto.reference || null,
                    currency: business.currency || 'NIO',
                    exchangeRate: 1,
                    amountBase: total,
                    shiftId: cashRegisterId,
                    createdById: cashierId,
                  },
                ],
              },
              subtotal,
              discountAmount,
              taxAmount,
              total,
              taxModel,
              listPriceTotal,
              listDiscountTotal,
              taxRate,
              taxEnabled,
              taxIncluded,
              paymentMethod: saleDto.paymentMethod,
              amountPaid,
              change,
              reference: saleDto.reference || null,
              notes: finalNotes,
              status: "COMPLETED",
            },
          });

          if (pendingAllocations.length > 0) {
            const createdItems = await tx.saleItem.findMany({
              where: { saleId: createdSale.id },
            });
            for (const pa of pendingAllocations) {
              const lineItem = createdItems.find((ci) => ci.productId === pa.productId);
              if (lineItem && pa.allocations.length > 0) {
                await tx.saleItemBatch.createMany({
                  data: pa.allocations.map((a: any) => ({
                    saleItemId: lineItem.id,
                    batchId: a.batchId,
                    quantity: a.quantity,
                  })),
                });
              }
            }
          }

          for (const disc of discrepancies) {
            if (disc.productId) {
              await tx.inventoryDiscrepancy.create({
                data: {
                  productId: disc.productId,
                  businessId,
                  saleId: createdSale.id,
                  expectedStock: disc.expectedStock,
                  resultingStock: disc.resultingStock,
                  notes: disc.notes || disc.message || `Venta offline ${invoiceNumber}: stock insuficiente (disponible: ${disc.expectedStock}, requerido: ${disc.expectedStock - disc.resultingStock})`,
                },
              });
            }
          }

          if (isOfflineCredit) {
            await tx.posAuditLog.create({
              data: {
                businessId,
                userId: cashierId,
                userRole: 'CAJERO',
                action: 'VENTA_OFFLINE_CREDITO_DISCREPANCIA',
                entityType: 'Sale',
                entityId: createdSale.id,
                reason: `Venta a crédito offline sin cuenta por cobrar: registrar manualmente (Venta: ${invoiceNumber}, Monto: C$${total.toFixed(2)}, Cliente: ${saleDto.customerName || 'No especificado'})`,
                after: { invoiceNumber, total, customerName: saleDto.customerName, customerPhone: saleDto.customerPhone },
              },
            });
          }

          if (discrepancies.length > 0) {
            await tx.posAuditLog.create({
              data: {
                businessId,
                userId: cashierId,
                userRole: 'CAJERO',
                action: 'VENTA_OFFLINE_STOCK_NEGATIVO',
                entityType: 'Sale',
                entityId: createdSale.id,
                reason: `Venta offline cobrada previamente generó stock negativo en ${discrepancies.length} producto(s)`,
                after: { invoiceNumber, discrepancies },
              },
            });
          }

          return {
            sale: createdSale,
            discrepancies,
          };
        });

        this.trackingGateway.notifyBusiness(businessId, "offline_sale_synced", {
          saleId: syncResult.sale.id,
          invoiceNumber: syncResult.sale.invoiceNumber,
          total: syncResult.sale.total,
          occurredAt: syncResult.sale.occurredAt,
          discrepanciesCount: syncResult.discrepancies.length,
        });

        results.push({
          clientGeneratedId: saleDto.clientGeneratedId,
          status: syncResult.discrepancies.length > 0 ? "SYNCED_WITH_DISCREPANCY" : "SYNCED",
          saleId: syncResult.sale.id,
          invoiceNumber: syncResult.sale.invoiceNumber,
          total: syncResult.sale.total,
          soldWithoutOpenShift: syncResult.sale.soldWithoutOpenShift,
          discrepancies: syncResult.discrepancies,
        });
      } catch (err: any) {
        this.logger.error(`[syncOfflineSales] Error sincronizando venta ${saleDto.clientGeneratedId}: ${err.message}`);
        results.push({
          clientGeneratedId: saleDto.clientGeneratedId,
          status: "ERROR",
          error: err.message,
        });
      }
    }

    if (terminal) {
      await this.prisma.posTerminal.update({
        where: { id: terminal.id },
        data: {
          hasPendingOfflineSales: false,
          pendingSalesCount: 0,
          lastSeenAt: new Date(),
        },
      });
    }

    return { results };
  }

  async getCatalogSnapshot(businessId: string, since?: string) {
    const [categories, products, business] = await Promise.all([
      this.prisma.category.findMany({
        where: { businessId, isActive: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.product.findMany({
        where: { businessId, isActive: true },
        include: {
          category: true,
          recipeComponents: {
            select: {
              componentProductId: true,
              quantity: true,
            },
          },
        },
        orderBy: { name: "asc" },
      }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: {
          wholesaleEnabled: true,
          tracksBatches: true,
          useListPrice: true,
          defaultMarkupPct: true,
          autoUpdatePriceOnPurchase: true,
        },
      }),
    ]);

    let batchMap = new Map<string, { activeBatchCount: number; nextExpiryDate: string | null }>();
    if (business?.tracksBatches) {
      const batchAggs: any[] = await this.prisma.$queryRaw`
        SELECT
          b."productId",
          COUNT(*)::int AS "activeBatchCount",
          MIN(b."expiryDate") AS "nextExpiryDate"
        FROM pos_product_batches b
        WHERE b."businessId" = ${businessId} AND b.quantity > 0
        GROUP BY b."productId";
      `;
      for (const row of batchAggs) {
        batchMap.set(row.productId, {
          activeBatchCount: Number(row.activeBatchCount || 0),
          nextExpiryDate: row.nextExpiryDate ? new Date(row.nextExpiryDate).toISOString().split('T')[0] : null,
        });
      }
    }

    let latestUpdate = new Date(0);
    for (const p of products) {
      if (p.updatedAt > latestUpdate) latestUpdate = p.updatedAt;
    }
    for (const c of categories) {
      if (c.createdAt > latestUpdate) latestUpdate = c.createdAt;
    }

    const snapshotVersion = latestUpdate.toISOString();

    if (since && new Date(since).getTime() >= latestUpdate.getTime()) {
      return {
        notModified: true,
        snapshotVersion,
        businessId,
        wholesale_enabled: business?.wholesaleEnabled ?? false,
        wholesaleEnabled: business?.wholesaleEnabled ?? false,
        tracks_batches: business?.tracksBatches ?? false,
        tracksBatches: business?.tracksBatches ?? false,
        use_list_price: business?.useListPrice ?? false,
        useListPrice: business?.useListPrice ?? false,
        default_markup_pct: business?.defaultMarkupPct != null ? Number(business.defaultMarkupPct) : null,
        defaultMarkupPct: business?.defaultMarkupPct != null ? Number(business.defaultMarkupPct) : null,
        auto_update_price_on_purchase: business?.autoUpdatePriceOnPurchase ?? false,
        autoUpdatePriceOnPurchase: business?.autoUpdatePriceOnPurchase ?? false,
      };
    }

    return {
      notModified: false,
      snapshotVersion,
      businessId,
      wholesale_enabled: business?.wholesaleEnabled ?? false,
      wholesaleEnabled: business?.wholesaleEnabled ?? false,
      tracks_batches: business?.tracksBatches ?? false,
      tracksBatches: business?.tracksBatches ?? false,
      use_list_price: business?.useListPrice ?? false,
      useListPrice: business?.useListPrice ?? false,
      default_markup_pct: business?.defaultMarkupPct != null ? Number(business.defaultMarkupPct) : null,
      defaultMarkupPct: business?.defaultMarkupPct != null ? Number(business.defaultMarkupPct) : null,
      auto_update_price_on_purchase: business?.autoUpdatePriceOnPurchase ?? false,
      autoUpdatePriceOnPurchase: business?.autoUpdatePriceOnPurchase ?? false,
      categories,
      products: products.map((p) => {
        const isRecipe = Boolean(p.isRecipe);
        const { recipeComponents, ...rest } = p;
        return {
          ...rest,
          stock: Number(p.stock),
          minStock: Number(p.minStock),
          maxStock: p.maxStock != null ? Number(p.maxStock) : null,
          wholesale_price: p.wholesalePrice != null ? Number(p.wholesalePrice) : null,
          wholesalePrice: p.wholesalePrice != null ? Number(p.wholesalePrice) : null,
          wholesale_min_qty: p.wholesaleMinQty != null ? Number(p.wholesaleMinQty) : null,
          wholesaleMinQty: p.wholesaleMinQty != null ? Number(p.wholesaleMinQty) : null,
          list_price: p.listPrice != null ? Number(p.listPrice) : null,
          listPrice: p.listPrice != null ? Number(p.listPrice) : null,
          markup_pct: p.markupPct != null ? Number(p.markupPct) : null,
          markupPct: p.markupPct != null ? Number(p.markupPct) : null,
          taxable: Boolean(p.taxable),
          unit: p.unit || 'UND',
          trackInventory: p.trackStock,
          isRecipe,
          ...(business?.tracksBatches
            ? {
                nextExpiryDate: batchMap.get(p.id)?.nextExpiryDate ?? null,
                next_expiry_date: batchMap.get(p.id)?.nextExpiryDate ?? null,
                activeBatchCount: batchMap.get(p.id)?.activeBatchCount ?? 0,
                active_batch_count: batchMap.get(p.id)?.activeBatchCount ?? 0,
              }
            : {}),
          ...(isRecipe && recipeComponents
            ? {
              components: recipeComponents.map((c) => ({
                productId: c.componentProductId,
                quantity: Number(c.quantity),
              })),
            }
            : {}),
        };
      }),
    };
  }

  async getDiscrepancies(businessId: string, resolved?: boolean) {
    const where: any = { businessId };
    if (resolved !== undefined) where.resolved = resolved;

    return this.prisma.inventoryDiscrepancy.findMany({
      where,
      include: {
        product: { select: { id: true, name: true, barcode: true, sku: true, stock: true } },
        sale: { select: { id: true, invoiceNumber: true, invoiceDate: true, total: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async resolveDiscrepancy(id: string, businessId: string, userId: string, dto: ResolveDiscrepancyDto) {
    const disc = await this.prisma.inventoryDiscrepancy.findFirst({
      where: { id, businessId },
    });
    if (!disc) throw new NotFoundException("Discrepancia no encontrada");

    return this.prisma.inventoryDiscrepancy.update({
      where: { id },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: userId,
        notes: dto.notes ? `${disc.notes || ""} | ${dto.notes}` : disc.notes,
      },
    });
  }
}

