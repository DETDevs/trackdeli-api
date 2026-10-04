import {
  Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger,
} from "@nestjs/common";
import { BusinessProductType, CreditAccountStatus, PosPaymentMethod } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { BusinessProductsService } from "../../business-products/business-products.service";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { CancelSaleDto } from "./dto/cancel-sale.dto";

import { PoliciesService } from '../policies/policies.service';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
    private readonly policiesService: PoliciesService,
  ) {}

  async create(dto: CreateSaleDto, businessId: string, cashierId: string) {
    return this.prisma.$transaction(async (tx) => {
      let cashRegisterId: string;
      if (dto.cashRegisterId) {
        const explicitRegister = await tx.cashRegister.findFirst({
          where: { id: dto.cashRegisterId, businessId, status: "OPEN" },
          select: { id: true },
        });
        if (!explicitRegister) {
          throw new ConflictException({
            statusCode: 409,
            code: 'NO_OPEN_SHIFT',
            message: 'La caja especificada no está abierta. Debes abrir un turno para registrar ventas.',
            error: 'Conflict',
          });
        }
        cashRegisterId = explicitRegister.id;
      } else {
        let activeRegister = await tx.cashRegister.findFirst({
          where: { businessId, cashierId, status: "OPEN" },
          select: { id: true },
        });
        if (!activeRegister) {
          activeRegister = await tx.cashRegister.findFirst({
            where: { businessId, status: "OPEN" },
            orderBy: { openedAt: "desc" },
            select: { id: true },
          });
        }
        if (!activeRegister) {
          throw new ConflictException({
            statusCode: 409,
            code: 'NO_OPEN_SHIFT',
            message: 'La caja está cerrada. Debes abrir un turno para registrar ventas.',
            error: 'Conflict',
          });
        }
        cashRegisterId = activeRegister.id;
      }

      const business = await tx.business.findUnique({
        where: { id: businessId },
        select: { invoicePrefix: true, invoiceCounter: true, taxRate: true, taxEnabled: true, taxIncluded: true, currency: true, name: true },
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
          if (product.trackStock === true && product.stock < item.quantity) {
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
      const finalSubtotal = subtotal - discountAmount;

      /* ==============================================================================
       * REGLAS SEMÁNTICAS DE CÁLCULO DE IMPUESTOS Y SUBTOTAL (TrackDeli API)
       * ==============================================================================
       * 1. `subtotal` = Suma de (item.unitPrice * item.quantity).
       * 2. `finalSubtotal` = `subtotal` - `dto.discountAmount`.
       * 3. Dependencia de "taxIncluded":
       *    - Si `taxIncluded === true`: Los `unitPrice` enviados por el cliente YA traen 
       *      el impuesto sumado. Por lo tanto, `total = finalSubtotal`. 
       *      El `taxAmount` se extrae hacia atrás: `finalSubtotal - (finalSubtotal / 1.15)`.
       *    - Si `taxIncluded === false`: Los `unitPrice` enviados NO traen impuesto. 
       *      El `taxAmount` se calcula hacia adelante: `finalSubtotal * 0.15`.
       *      El `total` será `finalSubtotal + taxAmount`.
       * 
       * NOTA: `isOfflineSync` permite relajar el rechazo por discrepancias, pero
       * el servidor sigue forzando este estándar de cálculo final en la BD.
       * ============================================================================== */

      let appliedTaxEnabled = business.taxEnabled;
      let appliedTaxIncluded = business.taxIncluded;
      let appliedTaxRate = business.taxRate;
      let hasAuditDiscrepancy = false;
      let auditNote = "";

      const hasClientSnapshot = dto.clientTotal !== undefined && dto.clientTaxEnabled !== undefined;

      if (hasClientSnapshot) {
        if (!dto.isOfflineSync) {
          // Venta online normal: Se ignora el snapshot del cliente si difiere y se audita
          if (
            dto.clientTaxEnabled !== business.taxEnabled ||
            dto.clientTaxIncluded !== business.taxIncluded ||
            (dto.clientTaxRate || 0) !== business.taxRate
          ) {
            hasAuditDiscrepancy = true;
            auditNote = `Venta ONLINE ignoró snapshot cliente (Rate: ${dto.clientTaxRate}, Enabled: ${dto.clientTaxEnabled}). Se usó vigente.`;
          }
        } else {
          // Venta offline (sincronización diferida)
          const occurredAtDate = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
          const msIn7Days = 7 * 24 * 60 * 60 * 1000;
          const isWithinWindow = (Date.now() - occurredAtDate.getTime()) <= msIn7Days;
          
          const perfectlyMatchesCurrent = 
            dto.clientTaxEnabled === business.taxEnabled && 
            dto.clientTaxIncluded === business.taxIncluded && 
            (dto.clientTaxRate || 0) === business.taxRate;

          if (isWithinWindow && perfectlyMatchesCurrent) {
            // Snapshot válido, coincide con la actual.
            appliedTaxEnabled = dto.clientTaxEnabled!;
            appliedTaxIncluded = dto.clientTaxIncluded!;
            appliedTaxRate = dto.clientTaxRate || 0;
          } else {
            // Fuera de ventana, o no coincide. Como no tenemos tabla de historial, 
            // recalculamos con la vigente y dejamos registro.
            hasAuditDiscrepancy = true;
            auditNote = `Venta OFFLINE recalculada con impuesto vigente. Snapshot cliente: Rate: ${dto.clientTaxRate}, Enabled: ${dto.clientTaxEnabled}, Total: ${dto.clientTotal}. Motivo: ${!isWithinWindow ? 'Fuera de ventana de 7 días.' : 'Discrepancia con configuración actual.'}`;
          }
        }
      }

      let calculatedTaxAmount = 0;
      let calculatedTotal = finalSubtotal;
      
      if (appliedTaxEnabled) {
        if (appliedTaxIncluded) {
          calculatedTaxAmount = finalSubtotal - (finalSubtotal / (1 + (appliedTaxRate / 100)));
        } else {
          calculatedTaxAmount = finalSubtotal * (appliedTaxRate / 100);
          calculatedTotal = finalSubtotal + calculatedTaxAmount;
        }
      }
      
      const taxAmount = Math.round(calculatedTaxAmount * 100) / 100;
      const total = Math.round(calculatedTotal * 100) / 100;

      if (hasClientSnapshot && !dto.isOfflineSync) {
        // En ventas online (tiempo real), SIEMPRE rechazamos si el cliente 
        // manda un total distinto al que el servidor calcula con la vigente.
        const diff = Math.abs(dto.clientTotal! - total);
        if (diff > 0.05) {
          throw new BadRequestException(`El cliente envió un total manipulado o desactualizado. Total enviado: ${dto.clientTotal}, Total calculado en servidor: C$ ${total}. ${hasAuditDiscrepancy ? auditNote : ''}`);
        }
      } else if (hasClientSnapshot && dto.isOfflineSync) {
        // En offline, si el total difiere del calculado, NO fallamos, solo lo registramos
        // para que la venta no se pierda. Se usa el 'total' del servidor.
        const diff = Math.abs(dto.clientTotal! - total);
        if (diff > 0.05) {
          hasAuditDiscrepancy = true;
          auditNote += ` Diferencia en total. Cliente exigía: C$ ${dto.clientTotal}. Servidor guardó: C$ ${total}.`;
        }
      }

      const finalNotes = hasAuditDiscrepancy ? `${dto.notes ? dto.notes + '. ' : ''}[AUDIT: ${auditNote.trim()}]` : dto.notes;

      const isCredit = (dto.paymentMethod as any) === PosPaymentMethod.CREDITO || (dto as any).paymentType === PosPaymentMethod.CREDITO;
      const paymentMethod = isCredit ? PosPaymentMethod.CREDITO : dto.paymentMethod;

      let customerId: string | null = null;
      let customerName = dto.customerName || null;
      let customerPhone = dto.customerPhone || null;
      let dueDate: Date | null = null;

      if (isCredit) {
        const isCarteraActive = await this.businessProductsService.isActive(
          businessId,
          BusinessProductType.CARTERA_COBRO,
        );
        if (!isCarteraActive) {
          throw new ForbiddenException('Este negocio no tiene Cartera de Cobro contratada');
        }

        let customer: any = null;

        if (dto.customerId) {
          customer = await tx.customer.findFirst({
            where: { id: dto.customerId, businessId },
          });
          if (!customer) {
            throw new BadRequestException("Cliente no encontrado o no pertenece a este negocio");
          }
        } else if (dto.customerPhone || customerPhone) {
          const cleanPhone = (dto.customerPhone || customerPhone || '').trim();
          customer = await tx.customer.findUnique({
            where: {
              businessId_phone: {
                businessId,
                phone: cleanPhone,
              },
            },
          });
          if (!customer) {
            customer = await tx.customer.create({
              data: {
                businessId,
                phone: cleanPhone,
                name: (customerName || dto.customerName || 'Cliente Crédito').trim(),
                ruc: dto.customerRuc?.trim() || null,
              },
            });
          } else if (customerName && customerName.trim() !== customer.name) {
            customer = await tx.customer.update({
              where: { id: customer.id },
              data: { name: customerName.trim() },
            });
          }
        } else {
          throw new BadRequestException("El cliente o su número de teléfono es obligatorio para ventas al crédito");
        }

        customerId = customer.id;
        if (!customerName) customerName = customer.name;
        if (!customerPhone) customerPhone = customer.phone;

        if (customer.creditLimit !== null && customer.creditLimit !== undefined) {
          const activeDebtAgg = await tx.creditAccount.aggregate({
            where: {
              customerId: customer.id,
              status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
            },
            _sum: { balance: true },
          });
          const currentDebt = activeDebtAgg._sum.balance || 0;
          if (currentDebt + total > customer.creditLimit) {
            throw new BadRequestException(
              `Límite de crédito excedido. Límite: ${customer.creditLimit.toFixed(2)}, Deuda actual: ${currentDebt.toFixed(2)}, Intentando cargar: ${total.toFixed(2)}`
            );
          }
        }

        if (dto.creditDueDate) {
          const parsedDueDate = new Date(dto.creditDueDate);
          if (isNaN(parsedDueDate.getTime())) {
            throw new BadRequestException("Fecha de vencimiento de crédito inválida");
          }
          dueDate = parsedDueDate;
        } else {
          dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        }
      } else if (dto.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: dto.customerId, businessId },
        });
        if (customer) {
          customerId = customer.id;
          if (!customerName) customerName = customer.name;
          if (!customerPhone) customerPhone = customer.phone;
        }
      } else if (dto.customerPhone || customerPhone) {
        const cleanPhone = (dto.customerPhone || customerPhone || '').trim();
        let customer = await tx.customer.findUnique({
          where: { businessId_phone: { businessId, phone: cleanPhone } },
        });
        if (!customer && (customerName || dto.customerName)) {
          customer = await tx.customer.create({
            data: {
              businessId,
              phone: cleanPhone,
              name: (customerName || dto.customerName)!.trim(),
              ruc: dto.customerRuc?.trim() || null,
            },
          });
        }
        if (customer) {
          customerId = customer.id;
          if (!customerName) customerName = customer.name;
        }
      }

      const policies = await this.policiesService.get(businessId);
      const enabledMethods = policies.paymentMethodsEnabled.split(',');

      let paymentsPayload = dto.payments;
      if (!paymentsPayload || paymentsPayload.length === 0) {
        // Fallback for older clients
        paymentsPayload = [{
          method: paymentMethod || PosPaymentMethod.EFECTIVO,
          amount: isCredit ? total : (dto.amountPaid ?? total),
          amountTendered: dto.amountPaid,
          reference: dto.reference
        }];
      }

      let totalPayments = 0;
      let totalChange = 0;
      let mainMethod = paymentsPayload.length === 1 ? paymentsPayload[0].method : PosPaymentMethod.MIXTO;

      const processedPayments = [];
      for (const p of paymentsPayload) {
        if (!enabledMethods.includes(p.method) && p.method !== PosPaymentMethod.CREDITO) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'PAYMENT_METHOD_DISABLED',
            message: `El método de pago ${p.method} no está habilitado`,
          });
        }

        let pChange = 0;
        let pAmountTendered = p.amountTendered ?? p.amount;

        if (p.method === PosPaymentMethod.EFECTIVO) {
           pChange = pAmountTendered - p.amount;
           if (pChange < 0) {
              throw new BadRequestException(`Monto entregado en efectivo es menor al monto a cobrar`);
           }
        } else {
           pAmountTendered = p.amount;
        }

        if (p.method === PosPaymentMethod.TARJETA && policies.requireReferenceCard && !p.reference) {
          throw new BadRequestException({ statusCode: 400, code: 'PAYMENT_REFERENCE_REQUIRED', message: 'Referencia requerida para pago con tarjeta' });
        }
        if (p.method === PosPaymentMethod.TRANSFERENCIA && policies.requireReferenceTransfer && !p.reference) {
          throw new BadRequestException({ statusCode: 400, code: 'PAYMENT_REFERENCE_REQUIRED', message: 'Referencia requerida para pago con transferencia' });
        }

        totalPayments += p.amount;
        totalChange += pChange;

        processedPayments.push({
           method: p.method,
           amount: p.amount,
           amountTendered: pAmountTendered,
           change: pChange,
           reference: p.reference || null,
           currency: business.currency,
           exchangeRate: 1,
           amountBase: p.amount,
           shiftId: cashRegisterId,
           createdById: cashierId
        });
      }

      if (Math.abs(totalPayments - total) > 0.05) {
         throw new BadRequestException({
            statusCode: 400,
            code: 'PAYMENT_TOTAL_MISMATCH',
            message: `La suma de los pagos (${totalPayments.toFixed(2)}) no coincide con el total de la venta (${total.toFixed(2)})`
         });
      }

      const sale = await tx.sale.create({
        data: {
          businessId,
          cashRegisterId,
          cashierId,
          invoiceNumber,
          customerId,
          customerName,
          customerPhone,
          customerRuc: dto.customerRuc || null,
          items: { create: processedItems },
          payments: { create: processedPayments },
          subtotal,
          discountAmount,
          taxRate: appliedTaxRate,
          taxEnabled: appliedTaxEnabled,
          taxIncluded: appliedTaxIncluded,
          taxAmount,
          total,
          paymentMethod: mainMethod,
          amountPaid: totalPayments + totalChange,
          change: totalChange,
          reference: dto.reference || null,
          notes: finalNotes || null,
          status: "COMPLETED",
        },
        include: { items: true, cashier: { select: { name: true } }, customer: true },
      });

      if (isCredit && customerId && dueDate) {
        await tx.creditAccount.create({
          data: {
            saleId: sale.id,
            customerId,
            businessId,
            originalAmount: total,
            balance: total,
            status: CreditAccountStatus.PENDING,
            dueDate,
          },
        });
      }

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
