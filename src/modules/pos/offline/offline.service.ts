import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  HttpException,
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
import { assertNotVariantParent } from "../products/variant.utils";
import { formatPresentation } from "../products/product-presentations.service";
import { resolveFieldIsFilterable } from "../product-fields/product-fields.service";
import { resolveSaleUnitsForBusiness } from "../products/sale-units-by-industry.constants";

import { BatchesService } from "../batches/batches.service";
import { calculateSaleTotals, RawSaleItemCalculationInput } from "../sales/utils/sale-calculation.util";
import { PosPaymentMethod, Prisma, ProductFieldDataType, UserRole } from "@prisma/client";

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
      where: {
        businessId,
        isActive: true,
        terminalType: { not: 'VENDEDOR' },
      },
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

  async registerTerminal(businessId: string, dto: RegisterTerminalDto, userRole?: string) {
    this.logger.log(`[registerTerminal] businessId=${businessId} deviceIdentifier=${dto.deviceIdentifier}`);

    const isVendedor = userRole === UserRole.VENDEDOR || dto.terminalType === 'VENDEDOR';
    const terminalType = isVendedor ? 'VENDEDOR' : (dto.terminalType || 'CAJA');

    const existingTerminal = await this.prisma.posTerminal.findUnique({
      where: { businessId_deviceIdentifier: { businessId, deviceIdentifier: dto.deviceIdentifier } },
    });

    if (existingTerminal && existingTerminal.isActive) {
      return this.prisma.posTerminal.update({
        where: { id: existingTerminal.id },
        data: {
          name: dto.name || existingTerminal.name,
          terminalType: isVendedor ? 'VENDEDOR' : (existingTerminal.terminalType || terminalType),
          lastSeenAt: new Date(),
        },
      });
    }

    const willBeActive = dto.isActive !== undefined ? dto.isActive : true;
    if (willBeActive && terminalType !== 'VENDEDOR') {
      await this.validateNoPendingOfflineSales(businessId, existingTerminal?.id);
    }

    const count = await this.prisma.posTerminal.count({ where: { businessId } });
    const defaultName = isVendedor ? `Vendedor ${count + 1}` : `Caja ${count + 1}`;

    return this.prisma.posTerminal.upsert({
      where: { businessId_deviceIdentifier: { businessId, deviceIdentifier: dto.deviceIdentifier } },
      create: {
        businessId,
        deviceIdentifier: dto.deviceIdentifier,
        name: dto.name || defaultName,
        terminalType,
        isActive: willBeActive,
        lastSeenAt: new Date(),
      },
      update: {
        name: dto.name || undefined,
        terminalType: isVendedor ? 'VENDEDOR' : undefined,
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

  async syncOfflineSales(businessId: string, cashierId: string, dto: SyncOfflineBatchDto, deviceId?: string) {
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
              deliveryChannelEnabled: true,
              deliveryDefaultFee: true,
              deliveryRequireDriver: true,
              pedidosYaChannelEnabled: true,
              pedidosYaCommissionPct: true,
              pedidosYaTaxPct: true,
              pedidosYaRequireOrderNumber: true,
            },
          });
          if (!business) throw new NotFoundException("Negocio no encontrado");

          const invoiceRows = await tx.$queryRaw<
            Array<{ invoicePrefix: string; invoiceCounter: number }>
          >`
            UPDATE "businesses"
            SET "invoiceCounter" = "invoiceCounter" + 1
            WHERE "id" = ${businessId}
            RETURNING "invoicePrefix", "invoiceCounter"
          `;
          if (!invoiceRows.length) throw new NotFoundException("Negocio no encontrado");

          const assignedInvoiceCounter = Number(invoiceRows[0].invoiceCounter) - 1;
          const invoiceNumber = `${invoiceRows[0].invoicePrefix}-${String(assignedInvoiceCounter).padStart(4, "0")}`;

          const rawItemsForCalc: RawSaleItemCalculationInput[] = [];
          const lineCostData: Array<{
            unitCost: number | null;
            costSource: string;
            unit: string;
            presentationId: string | null;
            presentationName: string | null;
            conversionFactor: number;
          }> = [];
          const discrepancies: any[] = [];
          const pendingAllocations: Array<{
            productId: string;
            presentationId: string | null;
            quantity: number;
            allocations: any[];
          }> = [];

          const businessUnits = await tx.posUnit.findMany({
            where: { businessId },
            select: { code: true, allowsDecimals: true },
          });
          const unitDecimalsMap = new Map<string, boolean>(
            businessUnits.map((u) => [u.code.toUpperCase(), u.allowsDecimals]),
          );

          for (const item of saleDto.items) {
            let itemAllocRes: any = null;
            let product: any = null;
            let presentation: any = null;
            let conversionFactor = 1;
            let requestedQty = round3(item.quantity);
            let baseQty = requestedQty;

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

              if (!product) {
                throw new NotFoundException({
                  statusCode: 404,
                  error: 'Not Found',
                  code: 'PRODUCT_NOT_FOUND',
                  message: 'Uno de los productos de esta venta ya no existe o cambió en el sistema.',
                  productId: item.productId,
                });
              }

              if (product) {
                assertNotVariantParent(product);
                if (item.presentationId) {
                  presentation = await tx.productPresentation.findFirst({
                    where: {
                      id: item.presentationId,
                      businessId,
                      productId: product.id,
                    },
                  });
                  if (!presentation) {
                    throw new NotFoundException({
                      statusCode: 404,
                      error: 'Not Found',
                      code: 'PRESENTATION_NOT_FOUND',
                      message: `La presentación seleccionada no existe para "${product.name}".`,
                    });
                  }
                  requestedQty = validateProductQuantity(
                    presentation.name,
                    item.quantity,
                    product.name,
                    false,
                    false,
                  );
                  conversionFactor = Number(presentation.factor);
                  baseQty = round3(requestedQty * conversionFactor);
                } else {
                  const prodUnitCode = (product.unit || 'UND').trim().toUpperCase();
                  requestedQty = validateProductQuantity(
                    prodUnitCode,
                    item.quantity,
                    product.name,
                    false,
                    unitDecimalsMap.get(prodUnitCode),
                  );
                  conversionFactor = 1;
                  baseQty = requestedQty;
                }
              }
            }

            if (product && product.isRecipe && product.recipeComponents && product.recipeComponents.length > 0) {
              // Producto con receta: descontar cada componente
              for (const comp of product.recipeComponents) {
                const compProd = comp.componentProduct;
                if (compProd && compProd.trackStock) {
                  const deductQty = round3(baseQty * Number(comp.quantity));
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
                      pendingAllocations.push({
                        productId: product.id,
                        presentationId: presentation?.id ?? null,
                        quantity: requestedQty,
                        allocations: allocRes.allocations,
                      });
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
              const expectedStock = Number(product.stock);
              const resultingStock = round3(expectedStock - baseQty);
              const baseUnitLabel = (product as any)?.baseUnitName?.trim() || 'Unidad';
              const presSuffix = presentation?.name
                ? ` (${requestedQty} ${presentation.name} x${conversionFactor} = ${baseQty} ${baseUnitLabel})`
                : '';

              const isTracked = this.batchesService.isTracked(business, product);
              if (isTracked) {
                const allocRes = await this.batchesService.allocateOffline(tx, {
                  businessId,
                  productId: product.id,
                  qty: baseQty,
                });
                itemAllocRes = allocRes;

                if (allocRes.allocations.length > 0) {
                  pendingAllocations.push({
                    productId: product.id,
                    presentationId: presentation?.id ?? null,
                    quantity: requestedQty,
                    allocations: allocRes.allocations,
                  });
                }

                for (const a of allocRes.allocations) {
                  const concept = a.isExpired
                    ? `Venta offline ${invoiceNumber}${presSuffix} (Lote vencido: ${a.batchNumber})`
                    : `Venta offline ${invoiceNumber}${presSuffix} (Lote: ${a.batchNumber})`;

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
                      concept: `Venta offline ${invoiceNumber}${presSuffix} (Sin lote asignado por stock insuficiente)`,
                      reference: saleDto.clientGeneratedId,
                      batchId: null,
                    },
                  });

                  discrepancies.push({
                    productId: product.id,
                    productName: product.name,
                    expectedStock: round3(baseQty - allocRes.unallocatedQty),
                    resultingStock: 0,
                    message: `Producto "${product.name}": ${allocRes.unallocatedQty} sin lote asignado por stock insuficiente`,
                    notes: `Venta offline ${invoiceNumber}${presSuffix}: ${allocRes.unallocatedQty} unidad(es) de "${product.name}" sin lote asignado por falta de stock`,
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
                    notes: `Venta offline ${invoiceNumber}${presSuffix}: salida de lote(s) vencido(s) para "${product.name}": ${expiredList}`,
                  });
                }
              } else {
                if (expectedStock < baseQty) {
                  discrepancies.push({
                    productId: product.id,
                    productName: product.name,
                    expectedStock,
                    resultingStock,
                    message: `Stock insuficiente para "${product.name}" (disponible: ${expectedStock}, solicitado: ${baseQty})`,
                    notes: `Venta offline ${invoiceNumber}${presSuffix}: stock insuficiente (disponible: ${expectedStock}, requerido: ${baseQty})`,
                  });
                }
                await tx.product.update({
                  where: { id: product.id },
                  data: { stock: { decrement: baseQty } },
                });

                await tx.stockMovement.create({
                  data: {
                    businessId,
                    productId: product.id,
                    userId: cashierId,
                    type: "VENTA",
                    quantity: -baseQty,
                    stockBefore: expectedStock,
                    stockAfter: resultingStock,
                    concept: `Venta offline ${invoiceNumber}${presSuffix}`,
                    reference: saleDto.clientGeneratedId,
                  },
                });
              }

              product.stock = resultingStock as any;
            }

            let listPrice: number | null = null;
            if (item.listPrice !== undefined && item.listPrice !== null) {
              listPrice = Number(item.listPrice);
            } else if (business.useListPrice && presentation?.listPrice != null) {
              listPrice = Number(presentation.listPrice);
            } else if (!presentation && business.useListPrice && product?.listPrice != null) {
              listPrice = Number(product.listPrice);
            }

            let taxable: boolean | null | undefined = undefined;
            if (item.taxable !== undefined && item.taxable !== null) {
              taxable = Boolean(item.taxable);
            }

            // 247c: Costo histórico y origen para la línea offline
            let itemUnitCost: number | null = null;
            let itemCostSource = 'NONE';

            if (product) {
              const hasRecipeComponents =
                Boolean(product.isRecipe) &&
                Array.isArray(product.recipeComponents) &&
                product.recipeComponents.length > 0;

              if (hasRecipeComponents) {
                let recipeCostSum = 0;
                let hasCompCost = false;
                for (const comp of product.recipeComponents) {
                  const compProd = comp.componentProduct;
                  if (compProd && compProd.cost != null) {
                    hasCompCost = true;
                    recipeCostSum += Number(comp.quantity) * Number(compProd.cost);
                  }
                }
                if (hasCompCost) {
                  itemUnitCost = Math.round(recipeCostSum * conversionFactor * 10000) / 10000;
                  itemCostSource = 'RECIPE';
                } else if (product.cost != null && Number(product.cost) > 0) {
                  itemUnitCost = Math.round(Number(product.cost) * conversionFactor * 10000) / 10000;
                  itemCostSource = 'PRODUCT';
                } else {
                  itemUnitCost = null;
                  itemCostSource = 'NONE';
                }
              } else if (product.type === 'SERVICE') {
                if (product.cost != null && Number(product.cost) > 0) {
                  itemUnitCost = Math.round(Number(product.cost) * conversionFactor * 10000) / 10000;
                  itemCostSource = 'PRODUCT';
                } else {
                  itemUnitCost = 0;
                  itemCostSource = 'LABOR';
                }
              } else if (itemAllocRes) {
                let allocQtySum = 0;
                let allocCostSum = 0;
                let hasAnyCost = false;
                for (const a of itemAllocRes.allocations || []) {
                  allocQtySum += a.quantity;
                  if (a.cost != null) {
                    hasAnyCost = true;
                    allocCostSum += (a.quantity * Number(a.cost));
                  } else if (product.cost != null) {
                    hasAnyCost = true;
                    allocCostSum += (a.quantity * Number(product.cost));
                  }
                }
                if (hasAnyCost && allocQtySum > 0) {
                  const baseBatchCost = allocCostSum / allocQtySum;
                  itemUnitCost = Math.round(baseBatchCost * conversionFactor * 10000) / 10000;
                  itemCostSource = 'BATCH';
                } else if (product.cost != null) {
                  itemUnitCost = Math.round(Number(product.cost) * conversionFactor * 10000) / 10000;
                  itemCostSource = 'PRODUCT';
                } else {
                  itemUnitCost = null;
                  itemCostSource = 'NONE';
                }
              } else if (product.cost != null) {
                itemUnitCost = Math.round(Number(product.cost) * conversionFactor * 10000) / 10000;
                itemCostSource = 'PRODUCT';
              } else {
                itemUnitCost = null;
                itemCostSource = 'NONE';
              }
            }

            lineCostData.push({
              unitCost: itemUnitCost,
              costSource: itemCostSource,
              unit: product?.unit ? String(product.unit).trim().toUpperCase() : 'UND',
              presentationId: presentation?.id ?? null,
              presentationName: presentation?.name ?? null,
              conversionFactor,
            });

            rawItemsForCalc.push({
              productId: item.productId || null,
              productName: item.productName || product?.name || 'Producto',
              barcode: item.barcode || presentation?.barcode || product?.barcode || null,
              unitPrice: item.unitPrice,
              quantity: requestedQty,
              discount: item.discount || 0,
              priceTier: (item as any).priceTier || 'RETAIL',
              allowDiscount: product ? (product as any).allowDiscount !== false : true,
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

          const processedItems = calcResult.lines.map((l, idx) => ({
            productId: l.productId,
            productName: l.productName,
            barcode: l.barcode,
            unit: lineCostData[idx]?.unit || 'UND',
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
            const coveringWhere: any = {
              businessId,
              openedAt: { lte: validOccurredAt },
              OR: [
                { closedAt: null },
                { closedAt: { gte: validOccurredAt } },
              ],
            };
            const cleanDeviceId = (deviceId || dto.deviceIdentifier || '').trim() || null;
            if (cleanDeviceId) {
              coveringWhere.deviceId = cleanDeviceId;
            } else {
              coveringWhere.cashierId = cashierId;
            }

            const coveringReg = await tx.cashRegister.findFirst({
              where: coveringWhere,
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

          let sellerId: string | null = null;
          let sellerName: string | null = null;
          if (saleDto.sellerId) {
            const seller = await tx.user.findFirst({
              where: { id: saleDto.sellerId, businessId, isActive: true },
              select: { id: true, name: true },
            });
            if (seller) {
              sellerId = seller.id;
              sellerName = seller.name;
            }
          } else if (saleDto.sellerName) {
            sellerName = saleDto.sellerName;
          }

          let presaleTicketId: string | null = null;
          let needsReview = false;
          let reviewReason: string | null = null;

          if (saleDto.presaleTicketId) {
            const ticket = await tx.presaleTicket.findFirst({
              where: { id: saleDto.presaleTicketId, businessId },
            });
            if (ticket) {
              if (ticket.status === 'CHARGED') {
                needsReview = true;
                reviewReason = `Ticket ${ticket.displayNumber} ya había sido cobrado (posible doble cobro)`;
                presaleTicketId = null;
              } else if (ticket.status === 'CANCELLED') {
                needsReview = true;
                reviewReason = `Ticket ${ticket.displayNumber} estaba anulado`;
              } else if (ticket.status === 'EXPIRED') {
                needsReview = true;
                reviewReason = `Ticket ${ticket.displayNumber} estaba vencido`;
              } else {
                await tx.presaleTicket.update({
                  where: { id: ticket.id },
                  data: {
                    status: 'CHARGED',
                    chargedAt: validOccurredAt,
                    chargedById: cashierId,
                  },
                });
                const ticketItems = await tx.presaleTicketItem.findMany({
                  where: { ticketId: ticket.id },
                });
                for (const tItem of ticketItems) {
                  if (tItem.productId && Number(tItem.reservedQty) > 0) {
                    await tx.product.update({
                      where: { id: tItem.productId },
                      data: { reservedStock: { decrement: Number(tItem.reservedQty) } },
                    });
                  }
                }
              }
            } else {
              needsReview = true;
              reviewReason = `Ticket ${saleDto.presaleTicketId} no encontrado en el servidor`;
            }
          }

          if (needsReview) {
            discrepancies.push({
              productId: processedItems[0]?.productId || null,
              productName: 'Revisión Venta Offline',
              expectedStock: 0,
              resultingStock: 0,
              message: `Revisión requerida: ${reviewReason} (Venta: ${invoiceNumber})`,
              notes: reviewReason,
            });
            finalNotes += ` [REVISIÓN: ${reviewReason}]`;
          }

          const rawChannel = (saleDto.channel || 'MOSTRADOR').toUpperCase().trim();
          if (!['MOSTRADOR', 'DOMICILIO', 'PEDIDOSYA'].includes(rawChannel)) {
            throw new BadRequestException('Canal de venta inválido. Los canales permitidos son MOSTRADOR, DOMICILIO o PEDIDOSYA');
          }
          if (rawChannel === 'DOMICILIO' && !business.deliveryChannelEnabled) {
            throw new BadRequestException('El canal de venta "A domicilio" no está activo para este negocio');
          }
          if (rawChannel === 'PEDIDOSYA' && !business.pedidosYaChannelEnabled) {
            throw new BadRequestException('El canal de venta "PedidosYa" no está activo para este negocio');
          }
          const channel = rawChannel;

          let pedidosYaCommissionPct: number | null = null;
          let pedidosYaTaxPct: number | null = null;
          let pedidosYaCommissionAmount: number | null = null;
          let pedidosYaTaxAmount: number | null = null;
          let pedidosYaNetPayout: number | null = null;
          let pedidosYaPaymentMode: string | null = null;
          let pedidosYaOrderNumber: string | null = null;
          let pedidosYaSettlementStatus: string | null = null;

          if (channel === 'PEDIDOSYA') {
            pedidosYaOrderNumber = saleDto.pedidosYaOrderNumber?.trim() || null;
            if (business.pedidosYaRequireOrderNumber && !pedidosYaOrderNumber) {
              throw new BadRequestException('El número de pedido de PedidosYa es obligatorio');
            }
            if (pedidosYaOrderNumber) {
              const existingPySale = await tx.sale.findFirst({
                where: {
                  businessId,
                  pedidosYaOrderNumber,
                  status: { notIn: ['CANCELLED', 'VOIDED', 'RETURNED'] },
                },
                select: { invoiceNumber: true },
              });
              if (existingPySale) {
                throw new ConflictException(`Ese pedido de PedidosYa ya se registró (${existingPySale.invoiceNumber})`);
              }
            }

            pedidosYaPaymentMode = saleDto.pedidosYaPaymentMode === 'EFECTIVO' ? 'EFECTIVO' : 'APP';
            const commPct = Number(business.pedidosYaCommissionPct ?? 27);
            const taxPct = Number(business.pedidosYaTaxPct ?? 7);
            pedidosYaCommissionPct = commPct;
            pedidosYaTaxPct = taxPct;
            const commAmount = Number(((total * commPct) / 100).toFixed(2));
            const tAmount = Number(((total * taxPct) / 100).toFixed(2));
            pedidosYaCommissionAmount = commAmount;
            pedidosYaTaxAmount = tAmount;
            pedidosYaNetPayout = pedidosYaPaymentMode === 'APP'
              ? Number((total - commAmount - tAmount).toFixed(2))
              : Number((-(commAmount + tAmount)).toFixed(2));
            pedidosYaSettlementStatus = 'PENDIENTE';
          }

          let deliveryFee = 0;
          let deliveryAddress: string | null = null;
          let deliveryPhone: string | null = null;
          let deliveryReference: string | null = null;
          let deliveryDriverId: string | null = null;
          let deliveryDriverName: string | null = null;

          if (channel === 'DOMICILIO') {
            const resolvedName = (saleDto.customerName || '').trim();
            if (!resolvedName) {
              throw new BadRequestException('Falta el nombre del cliente');
            }

            const resolvedPhone = (saleDto.deliveryPhone || saleDto.customerPhone || '').trim();
            if (!resolvedPhone) {
              throw new BadRequestException('Falta el teléfono del cliente');
            }

            const resolvedAddr = (saleDto.deliveryAddress || '').trim();
            if (!resolvedAddr) {
              throw new BadRequestException('Falta la dirección del cliente');
            }

            deliveryAddress = resolvedAddr;
            deliveryPhone = resolvedPhone;
            deliveryReference = saleDto.deliveryReference?.trim() || null;
            deliveryDriverId = saleDto.deliveryDriverId || null;
            deliveryDriverName = saleDto.deliveryDriverName?.trim() || null;

            if (business.deliveryRequireDriver && !deliveryDriverId && !deliveryDriverName) {
              throw new BadRequestException('Se requiere asignar un repartidor para la entrega a domicilio');
            }

            deliveryFee = saleDto.deliveryFee != null ? Math.max(0, Number(saleDto.deliveryFee)) : (business.deliveryDefaultFee ?? 0);
          }

          const actualPaymentMethod = (channel === 'PEDIDOSYA' && pedidosYaPaymentMode === 'APP')
            ? ('PEDIDOSYA_APP' as PosPaymentMethod)
            : saleDto.paymentMethod;

          const finalAmountPaid = actualPaymentMethod === 'PEDIDOSYA_APP' ? total : amountPaid;
          const finalChange = actualPaymentMethod === 'PEDIDOSYA_APP' ? 0 : change;

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
              customerName: channel === 'DOMICILIO' ? (saleDto.customerName?.trim() || null) : (saleDto.customerName || null),
              customerPhone: channel === 'DOMICILIO' ? (deliveryPhone || null) : (saleDto.customerPhone || null),
              customerRuc: saleDto.customerRuc || null,
              sellerId,
              sellerName,
              presaleTicketId,
              needsReview,
              reviewReason,
              channel,
              deliveryFee,
              deliveryAddress,
              deliveryPhone,
              deliveryReference,
              deliveryDriverId,
              deliveryDriverName,
              pedidosYaOrderNumber,
              pedidosYaPaymentMode,
              pedidosYaCommissionPct,
              pedidosYaTaxPct,
              pedidosYaCommissionAmount,
              pedidosYaTaxAmount,
              pedidosYaNetPayout,
              pedidosYaSettlementStatus,
              items: {
                create: calcResult.lines.map((l, idx) => ({
                  productId: l.productId,
                  productName: l.productName,
                  barcode: l.barcode,
                  unit: lineCostData[idx]?.unit || 'UND',
                  presentationId: lineCostData[idx]?.presentationId ?? null,
                  presentationName: lineCostData[idx]?.presentationName ?? null,
                  conversionFactor: new Prisma.Decimal(lineCostData[idx]?.conversionFactor ?? 1),
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
                  origin: (saleDto.items[idx] as any)?.origin || 'CASHIER',
                  unitCost: lineCostData[idx]?.unitCost ?? null,
                  costSource: lineCostData[idx]?.costSource ?? 'NONE',
                })),
              },
              payments: {
                create: [
                  {
                    method: actualPaymentMethod,
                    amount: total,
                    amountTendered: finalAmountPaid,
                    change: finalChange,
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
              paymentMethod: actualPaymentMethod,
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
            const usedAllocSaleItemIds = new Set<string>();
            for (const pa of pendingAllocations) {
              const lineItem = createdItems.find(
                (ci) =>
                  !usedAllocSaleItemIds.has(ci.id) &&
                  ci.productId === pa.productId &&
                  (ci.presentationId ?? null) === (pa.presentationId ?? null) &&
                  Math.abs(Number(ci.quantity) - Number(pa.quantity)) <= 0.001,
              );
              if (lineItem && pa.allocations.length > 0) {
                usedAllocSaleItemIds.add(lineItem.id);
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
        const mapped = this.mapOfflineSaleError(err);
        const rawDetail =
          err instanceof HttpException
            ? JSON.stringify(err.getResponse())
            : err instanceof Error
            ? err.message
            : String(err);
        this.logger.error(
          `[syncOfflineSales] Error sincronizando venta businessId=${businessId} clientGeneratedId=${saleDto.clientGeneratedId} code=${mapped.code}: ${rawDetail}`,
          err instanceof Error ? err.stack : undefined,
        );
        results.push({
          clientGeneratedId: saleDto.clientGeneratedId,
          status: "ERROR",
          code: mapped.code,
          message: mapped.message,
          error: mapped.message,
        });
      }
    }

    if (terminal) {
      const failedCount = results.filter((r) => r.status === "ERROR").length;
      await this.prisma.posTerminal.update({
        where: { id: terminal.id },
        data: {
          hasPendingOfflineSales: failedCount > 0,
          pendingSalesCount: failedCount,
          lastSeenAt: new Date(),
        },
      });
    }

    return { results };
  }

  private looksTechnicalMessage(msg: string): boolean {
    return /invalid\s+`|\bprisma\b|[a-z]:\\|\/app\/|\.(js|ts):\d+|constraint\s+violated|\bfkey\b|cannot\s+read\s+propert|undefined\s+is\s+not|syntax\s+error|econnrefused|stack\s*:/i.test(
      msg,
    );
  }

  private mapOfflineSaleError(err: unknown): { code: string; message: string } {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2003') {
        const target = `${JSON.stringify(err.meta ?? {})} ${err.message}`.toLowerCase();
        if (target.includes('presentation')) {
          return {
            code: 'PRESENTATION_NOT_FOUND',
            message: 'Una de las formas de venta seleccionadas ya no existe en el sistema.',
          };
        }
        if (target.includes('product')) {
          return {
            code: 'PRODUCT_NOT_FOUND',
            message: 'Uno de los productos de esta venta ya no existe o cambió en el sistema.',
          };
        }
        if (target.includes('cashregister') || target.includes('cash_register') || target.includes('shift')) {
          return {
            code: 'CASH_REGISTER_NOT_FOUND',
            message: 'El turno de caja asociado a esta venta ya no existe.',
          };
        }
        if (target.includes('customer')) {
          return {
            code: 'CUSTOMER_NOT_FOUND',
            message: 'El cliente asociado a esta venta ya no existe.',
          };
        }
        return {
          code: 'INVALID_SALE',
          message: 'Uno de los datos relacionados con esta venta ya no existe.',
        };
      }
      if (err.code === 'P2002') {
        return {
          code: 'INVALID_SALE',
          message: 'Esta venta tiene un dato duplicado que ya fue registrado.',
        };
      }
      if (err.code === 'P2025') {
        return {
          code: 'INVALID_SALE',
          message: 'Uno de los datos necesarios para guardar esta venta ya no existe.',
        };
      }
      return {
        code: 'UNKNOWN_ERROR',
        message: 'El servidor no pudo guardar esta venta.',
      };
    }

    if (
      err instanceof Prisma.PrismaClientValidationError ||
      err instanceof Prisma.PrismaClientUnknownRequestError ||
      err instanceof Prisma.PrismaClientRustPanicError ||
      err instanceof Prisma.PrismaClientInitializationError
    ) {
      return {
        code: 'UNKNOWN_ERROR',
        message: 'El servidor no pudo guardar esta venta.',
      };
    }

    if (err instanceof HttpException) {
      const status = err.getStatus();
      const res = err.getResponse() as any;
      const resCode = typeof res === 'object' && res !== null && typeof res.code === 'string'
        ? res.code
        : undefined;
      const rawMsg =
        typeof res === 'string'
          ? res
          : typeof res?.message === 'string'
          ? res.message
          : Array.isArray(res?.message)
          ? res.message.join(', ')
          : '';

      if (status >= 500) {
        return {
          code: resCode || 'UNKNOWN_ERROR',
          message: 'El servidor no pudo guardar esta venta.',
        };
      }

      const safeMsg =
        rawMsg && !this.looksTechnicalMessage(rawMsg)
          ? rawMsg
          : 'Esta venta tiene datos inválidos y no se pudo guardar.';

      return {
        code: resCode || 'INVALID_SALE',
        message: safeMsg,
      };
    }

    return {
      code: 'UNKNOWN_ERROR',
      message: 'El servidor no pudo guardar esta venta.',
    };
  }

  async getCatalogSnapshot(businessId: string, since?: string) {
    const [categories, products, business, activeFieldsWithOptions, presentationAgg, soldAggs] = await Promise.all([
      this.prisma.category.findMany({
        where: { businessId, isActive: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.product.findMany({
        where: { businessId, isActive: true, isVariantParent: false },
        include: {
          category: true,
          presentations: {
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          },
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
          type: true,
          posVertical: true,
          industry: { select: { code: true, name: true } },
          wholesaleEnabled: true,
          tracksBatches: true,
          useListPrice: true,
          defaultMarkupPct: true,
          autoUpdatePriceOnPurchase: true,
          twoStepSaleEnabled: true,
          twoStepTicketTtlHours: true,
        },
      }),
      this.prisma.productFieldDefinition.findMany({
        where: {
          businessId,
          isActive: true,
        },
        include: {
          fieldOptions: {
            where: { isActive: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.productPresentation.aggregate({
        where: { businessId },
        _max: { updatedAt: true },
      }),
      this.prisma.$queryRaw<Array<{ productId: string; soldQty30d: number }>>`
        SELECT
          si."productId" AS "productId",
          COALESCE(
            SUM(GREATEST(0, si."quantity" - COALESCE(si."returnedQty", 0)) * COALESCE(si."conversionFactor", 1)),
            0
          )::float AS "soldQty30d"
        FROM "pos_sale_items" si
        INNER JOIN "pos_sales" s ON s."id" = si."saleId"
        WHERE s."businessId" = ${businessId}
          AND s."status" IN ('COMPLETED', 'PARTIALLY_RETURNED')
          AND s."createdAt" >= NOW() - INTERVAL '30 days'
          AND si."productId" IS NOT NULL
        GROUP BY si."productId";
      `,
    ]);

    const soldMap = new Map<string, number>();
    for (const row of soldAggs || []) {
      if (row.productId) {
        soldMap.set(row.productId, Math.round(Number(row.soldQty30d || 0) * 1000) / 1000);
      }
    }
    const listFieldsWithOptions = activeFieldsWithOptions.filter(
      (f) => f.dataType === ProductFieldDataType.LIST,
    );

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
    for (const f of activeFieldsWithOptions) {
      if (f.updatedAt > latestUpdate) latestUpdate = f.updatedAt;
      for (const opt of f.fieldOptions) {
        if (opt.updatedAt > latestUpdate) latestUpdate = opt.updatedAt;
      }
    }
    if (presentationAgg?._max?.updatedAt && presentationAgg._max.updatedAt > latestUpdate) {
      latestUpdate = presentationAgg._max.updatedAt;
    }

    const fieldOptions = listFieldsWithOptions.flatMap((f) =>
      f.fieldOptions.map((opt) => ({
        id: opt.id,
        businessId: opt.businessId,
        fieldDefinitionId: opt.fieldDefinitionId,
        fieldKey: f.key,
        label: opt.label,
        normalizedLabel: opt.normalizedLabel,
        sortOrder: opt.sortOrder,
        isActive: opt.isActive,
      }))
    );

    const productFields = activeFieldsWithOptions.map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      dataType: f.dataType,
      order: f.order,
      required: f.required,
      searchable: f.searchable,
      showInPos: f.showInPos,
      allowCreateInline: f.allowCreateInline,
      isFilterable: resolveFieldIsFilterable(f),
      showOnCard: Boolean((f as any).showOnCard),
      options:
        f.dataType === ProductFieldDataType.LIST
          ? f.fieldOptions.map((opt) => ({
              id: opt.id,
              label: opt.label,
              sortOrder: opt.sortOrder,
            }))
          : Array.isArray(f.options)
            ? (f.options as any[]).map((label, idx) => ({
                id: null,
                label: String(label),
                sortOrder: idx,
              }))
            : [],
    }));

    const snapshotVersion = latestUpdate.toISOString();
    const saleUnits = resolveSaleUnitsForBusiness({
      industryCode: business?.industry?.code,
      industryName: business?.industry?.name,
      businessType: business?.type,
      posVertical: business?.posVertical,
    });

    if (since && new Date(since).getTime() >= latestUpdate.getTime()) {
      return {
        notModified: true,
        snapshotVersion,
        businessId,
        saleUnits,
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
        two_step_sale_enabled: business?.twoStepSaleEnabled ?? false,
        twoStepSaleEnabled: business?.twoStepSaleEnabled ?? false,
        two_step_ticket_ttl_hours: business?.twoStepTicketTtlHours ?? 4,
        twoStepTicketTtlHours: business?.twoStepTicketTtlHours ?? 4,
      };
    }

    return {
      notModified: false,
      snapshotVersion,
      businessId,
      saleUnits,
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
      two_step_sale_enabled: business?.twoStepSaleEnabled ?? false,
      twoStepSaleEnabled: business?.twoStepSaleEnabled ?? false,
      two_step_ticket_ttl_hours: business?.twoStepTicketTtlHours ?? 4,
      twoStepTicketTtlHours: business?.twoStepTicketTtlHours ?? 4,
      categories,
      fieldOptions,
      field_options: fieldOptions,
      productFields,
      product_fields: productFields,
      products: products.map((p) => {
        const isRecipe = Boolean(p.isRecipe);
        const { recipeComponents, reservedStock: _rStock, presentations: rawPresentations, ...rest } = p as any;
        const stockNum = Number(p.stock);
        return {
          ...rest,
          stock: stockNum,
          minStock: Number(p.minStock),
          maxStock: p.maxStock != null ? Number(p.maxStock) : null,
          wholesale_price: p.wholesalePrice != null ? Number(p.wholesalePrice) : null,
          wholesalePrice: p.wholesalePrice != null ? Number(p.wholesalePrice) : null,
          wholesale_min_qty: p.wholesaleMinQty != null ? Number(p.wholesaleMinQty) : null,
          wholesaleMinQty: p.wholesaleMinQty != null ? Number(p.wholesaleMinQty) : null,
          allow_discount: (p as any).allowDiscount !== false,
          allowDiscount: (p as any).allowDiscount !== false,
          promo_discount_pct: (p as any).promoDiscountPct != null ? Number((p as any).promoDiscountPct) : null,
          promoDiscountPct: (p as any).promoDiscountPct != null ? Number((p as any).promoDiscountPct) : null,
          list_price: p.listPrice != null ? Number(p.listPrice) : null,
          listPrice: p.listPrice != null ? Number(p.listPrice) : null,
          markup_pct: p.markupPct != null ? Number(p.markupPct) : null,
          markupPct: p.markupPct != null ? Number(p.markupPct) : null,
          taxable: Boolean(p.taxable),
          unit: p.unit || 'UND',
          baseUnitName: (p as any).baseUnitName?.trim() || 'Unidad',
          presentations: Array.isArray(rawPresentations)
            ? rawPresentations.map((pr: any) => formatPresentation(pr, undefined, stockNum))
            : [],
          trackInventory: p.trackStock,
          isRecipe,
          soldQty30d: soldMap.get(p.id) ?? 0,
          ...(business?.tracksBatches
            ? {
                nextExpiryDate: batchMap.get(p.id)?.nextExpiryDate ?? null,
                next_expiry_date: batchMap.get(p.id)?.nextExpiryDate ?? null,
                nearestExpiry: batchMap.get(p.id)?.nextExpiryDate ?? null,
                activeBatchCount: batchMap.get(p.id)?.activeBatchCount ?? 0,
                active_batch_count: batchMap.get(p.id)?.activeBatchCount ?? 0,
              }
            : {}),
          ...(business?.twoStepSaleEnabled
            ? {
                reservedStock: Number(p.reservedStock || 0),
                reserved_stock: Number(p.reservedStock || 0),
                availableStock: Math.max(0, Number(p.stock) - Number(p.reservedStock || 0)),
                available_stock: Math.max(0, Number(p.stock) - Number(p.reservedStock || 0)),
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

