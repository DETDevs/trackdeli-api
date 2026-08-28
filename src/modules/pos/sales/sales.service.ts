import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { CancelSaleDto } from "./dto/cancel-sale.dto";

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSaleDto, businessId: string, cashierId: string) {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.findUnique({
        where: { id: businessId },
        select: { invoicePrefix: true, invoiceCounter: true, taxRate: true, currency: true, name: true },
      });
      if (!business) throw new NotFoundException("Negocio no encontrado");

      const invoiceNumber = `${business.invoicePrefix}-${String(business.invoiceCounter).padStart(4, "0")}`;

      await tx.business.update({
        where: { id: businessId },
        data: { invoiceCounter: { increment: 1 } },
      });

      let subtotal = 0;
      const processedItems: any[] = [];

      for (const item of dto.items) {
        if (item.productId) {
          const product = await tx.product.findFirst({ where: { id: item.productId, businessId } });
          if (!product) throw new NotFoundException(`Producto ${item.productId} no encontrado`);
          if (product.trackStock && product.stock < item.quantity) {
            throw new BadRequestException(
              `Stock insuficiente para "${product.name}". Disponible: ${product.stock}`
            );
          }
        }

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
      }

      const discountAmount = dto.discountAmount || 0;
      const taxableAmount = subtotal - discountAmount;
      const taxAmount = taxableAmount * (business.taxRate / 100);
      const total = taxableAmount + taxAmount;
      const change = dto.amountPaid - total;

      if (change < 0) {
        throw new BadRequestException(
          `Monto insuficiente. Total: ${total.toFixed(2)}, Pagado: ${dto.amountPaid}`
        );
      }

      const sale = await tx.sale.create({
        data: {
          businessId,
          cashRegisterId: dto.cashRegisterId || null,
          cashierId,
          invoiceNumber,
          customerName: dto.customerName || null,
          customerPhone: dto.customerPhone || null,
          customerRuc: dto.customerRuc || null,
          items: { create: processedItems },
          subtotal,
          discountAmount,
          taxAmount,
          total,
          paymentMethod: dto.paymentMethod,
          amountPaid: dto.amountPaid,
          change,
          reference: dto.reference || null,
          notes: dto.notes || null,
          status: "COMPLETED",
        },
        include: { items: true, cashier: { select: { name: true } } },
      });

      for (const item of dto.items) {
        if (item.productId) {
          const product = await tx.product.findUnique({ where: { id: item.productId } });
          if (product?.trackStock) {
            const qty = Math.ceil(item.quantity);
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { decrement: qty } },
            });
            await tx.stockMovement.create({
              data: {
                businessId,
                productId: item.productId,
                userId: cashierId,
                type: "VENTA",
                quantity: -qty,
                stockBefore: product.stock,
                stockAfter: product.stock - qty,
                concept: `Venta ${invoiceNumber}`,
                reference: sale.id,
              },
            });
          }
        }
      }

      this.logger.log(`[create] Venta: ${invoiceNumber} total=${total.toFixed(2)} metodo=${dto.paymentMethod} negocio=${businessId}`);
      return sale;
    });
  }

  async findAll(
    businessId: string,
    filters?: { from?: string; to?: string; status?: string; paymentMethod?: string; cashRegisterId?: string }
  ) {
    const where: any = { businessId };
    if (filters?.status) where.status = filters.status;
    if (filters?.paymentMethod) where.paymentMethod = filters.paymentMethod;
    if (filters?.cashRegisterId) where.cashRegisterId = filters.cashRegisterId;
    if (filters?.from || filters?.to) {
      where.createdAt = {};
      if (filters.from) {
        where.createdAt.gte = filters.from.includes('T') ? new Date(filters.from) : new Date(`${filters.from}T00:00:00.000Z`);
      }
      if (filters.to) {
        where.createdAt.lte = filters.to.includes('T') ? new Date(filters.to) : new Date(`${filters.to}T23:59:59.999Z`);
      }
    }

    return this.prisma.sale.findMany({
      where,
      include: {
        items: true,
        cashier: { select: { id: true, name: true } },
        cashRegister: { select: { id: true, openedAt: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async findOne(id: string, businessId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId },
      include: {
        items: { include: { product: { select: { name: true, barcode: true } } } },
        cashier: { select: { id: true, name: true } },
        cashRegister: { select: { id: true, openedAt: true } },
      },
    });
    if (!sale) throw new NotFoundException("Venta no encontrada");
    return sale;
  }

  async cancel(id: string, businessId: string, dto: CancelSaleDto) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId },
      include: { items: { include: { product: true } } },
    });
    if (!sale) throw new NotFoundException("Venta no encontrada");
    if (sale.status !== "COMPLETED") {
      throw new BadRequestException("Solo se pueden anular ventas completadas");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sale.update({ where: { id }, data: { status: "CANCELLED", notes: dto.reason || sale.notes } });

      for (const item of sale.items) {
        if (item.productId) {
          const product = await tx.product.findUnique({ where: { id: item.productId } });
          if (product?.trackStock) {
            const qty = Math.ceil(item.quantity);
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: qty } },
            });
            await tx.stockMovement.create({
              data: {
                businessId,
                productId: item.productId,
                userId: sale.cashierId,
                type: "DEVOLUCION",
                quantity: qty,
                stockBefore: product.stock,
                stockAfter: product.stock + qty,
                concept: `Anulación venta ${sale.invoiceNumber}`,
                reference: id,
              },
            });
          }
        }
      }
    });

    this.logger.log(`[cancel] Venta anulada: ${sale.invoiceNumber} businessId=${businessId}`);
    return this.findOne(id, businessId);
  }

  async getReceiptData(id: string, businessId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId },
      include: {
        items: true,
        cashier: { select: { name: true } },
        business: {
          select: { name: true, posAddress: true, posPhone: true, posFooter: true, currency: true, taxRate: true },
        },
      },
    });
    if (!sale) throw new NotFoundException("Venta no encontrada");

    await this.prisma.sale.update({ where: { id }, data: { printCount: { increment: 1 } } });

    return {
      businessName: sale.business.name,
      businessAddress: sale.business.posAddress,
      businessPhone: sale.business.posPhone,
      footer: sale.business.posFooter || "¡Gracias por su compra!",
      invoiceNumber: sale.invoiceNumber,
      date: sale.invoiceDate,
      cashierName: sale.cashier.name,
      customerName: sale.customerName,
      customerRuc: sale.customerRuc,
      items: sale.items.map((item) => ({
        name: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        subtotal: item.subtotal,
      })),
      subtotal: sale.subtotal,
      discountAmount: sale.discountAmount,
      taxAmount: sale.taxAmount,
      taxRate: sale.business.taxRate,
      total: sale.total,
      amountPaid: sale.amountPaid,
      change: sale.change,
      paymentMethod: sale.paymentMethod,
      currency: sale.business.currency,
    };
  }
}
