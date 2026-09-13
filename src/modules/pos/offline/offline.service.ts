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

@Injectable()
export class OfflineService {
  private readonly logger = new Logger(OfflineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
  ) {}

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
            select: { invoicePrefix: true, invoiceCounter: true, taxRate: true },
          });
          if (!business) throw new NotFoundException("Negocio no encontrado");

          const invoiceNumber = `${business.invoicePrefix}-${String(business.invoiceCounter).padStart(4, "0")}`;
          await tx.business.update({
            where: { id: businessId },
            data: { invoiceCounter: { increment: 1 } },
          });

          let subtotal = 0;
          const processedItems: any[] = [];
          const discrepancies: any[] = [];

          for (const item of saleDto.items) {
            const itemDiscount = item.discount || 0;
            const itemSubtotal = item.unitPrice * item.quantity - itemDiscount;
            subtotal += itemSubtotal;

            processedItems.push({
              productId: item.productId || null,
              productName: item.productName,
              barcode: item.barcode || null,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
              discount: itemDiscount,
              subtotal: itemSubtotal,
            });

            if (item.productId) {
              const product = await tx.product.findFirst({
                where: { id: item.productId, businessId },
              });

              if (product && product.trackStock) {
                const qty = Math.ceil(item.quantity);
                const expectedStock = product.stock;
                const resultingStock = product.stock - qty;

                if (product.stock < qty) {
                  discrepancies.push({
                    productId: product.id,
                    expectedStock,
                    resultingStock,
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
            }
          }

          const discountAmount = saleDto.discountAmount || 0;
          const taxableAmount = Math.max(0, subtotal - discountAmount);
          const taxAmount = taxableAmount * (business.taxRate / 100);
          const total = taxableAmount + taxAmount;
          const change = Math.max(0, saleDto.amountPaid - total);

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

          const notesPrefix = soldWithoutOpenShift ? "[Offline][Sin Turno Abierto]" : "[Offline]";
          const finalNotes = saleDto.notes ? `${notesPrefix} ${saleDto.notes}` : notesPrefix;

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
              clientGeneratedId: saleDto.clientGeneratedId,
              posTerminalId: terminal?.id || null,
              customerName: saleDto.customerName || null,
              customerPhone: saleDto.customerPhone || null,
              customerRuc: saleDto.customerRuc || null,
              items: { create: processedItems },
              subtotal,
              discountAmount,
              taxAmount,
              total,
              paymentMethod: saleDto.paymentMethod,
              amountPaid: saleDto.amountPaid,
              change,
              reference: saleDto.reference || null,
              notes: finalNotes,
              status: "COMPLETED",
            },
          });

          for (const disc of discrepancies) {
            await tx.inventoryDiscrepancy.create({
              data: {
                productId: disc.productId,
                businessId,
                saleId: createdSale.id,
                expectedStock: disc.expectedStock,
                resultingStock: disc.resultingStock,
                notes: `Venta offline ${invoiceNumber}: stock insuficiente (disponible: ${disc.expectedStock}, requerido: ${disc.expectedStock - disc.resultingStock})`,
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
    const categories = await this.prisma.category.findMany({
      where: { businessId, isActive: true },
      orderBy: { name: "asc" },
    });

    const products = await this.prisma.product.findMany({
      where: { businessId, isActive: true },
      include: { category: true },
      orderBy: { name: "asc" },
    });

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
      };
    }

    return {
      notModified: false,
      snapshotVersion,
      businessId,
      categories,
      products: products.map((p) => ({
        ...p,
        trackInventory: p.trackStock,
      })),
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

