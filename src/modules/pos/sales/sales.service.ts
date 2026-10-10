import {
  Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, UnprocessableEntityException, Logger,
} from "@nestjs/common";
import { BusinessProductType, CreditAccountStatus, PosPaymentMethod, Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { BusinessProductsService } from "../../business-products/business-products.service";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { CancelSaleDto } from "./dto/cancel-sale.dto";
import { VoidSaleDto } from "./dto/void-sale.dto";
import { CreateReturnDto } from "./dto/create-return.dto";

import { PoliciesService } from '../policies/policies.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PosAction } from '../permissions/permissions.service';
import { validateProductQuantity, round3 } from '../products/product-unit.util';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
    private readonly policiesService: PoliciesService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly auditService: AuditService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  private formatSale(sale: any, userRole?: string) {
    if (!sale) return null;
    return {
      ...sale,
      subtotal: sale.subtotal != null ? Number(new Prisma.Decimal(sale.subtotal.toString()).toDecimalPlaces(2)) : 0,
      total: sale.total != null ? Number(new Prisma.Decimal(sale.total.toString()).toDecimalPlaces(2)) : 0,
      discountAmount: sale.discountAmount != null ? Number(new Prisma.Decimal(sale.discountAmount.toString()).toDecimalPlaces(2)) : 0,
      taxAmount: sale.taxAmount != null ? Number(new Prisma.Decimal(sale.taxAmount.toString()).toDecimalPlaces(2)) : 0,
      amountPaid: sale.amountPaid != null ? Number(new Prisma.Decimal(sale.amountPaid.toString()).toDecimalPlaces(2)) : 0,
      change: sale.change != null ? Number(new Prisma.Decimal(sale.change.toString()).toDecimalPlaces(2)) : 0,
      items: (sale.items || []).map((i: any) => {
        const itemCopy = {
          ...i,
          returnedQty: i.returnedQty != null ? Number(new Prisma.Decimal(i.returnedQty.toString()).toDecimalPlaces(2)) : 0,
          returnableQty: Math.max(0, (i.quantity || 0) - (i.returnedQty || 0)),
        };
        if (itemCopy.product) {
          if (userRole === UserRole.CAJERO || userRole === UserRole.WAITER) {
            delete itemCopy.product.cost;
            delete itemCopy.product.costAtTime;
          }
        }
        if (userRole === UserRole.CAJERO || userRole === UserRole.WAITER) {
          delete itemCopy.cost;
          delete itemCopy.costAtTime;
        }
        return itemCopy;
      }),
      returns: (sale.returns || []).map((r: any) => ({
        ...r,
        refundAmount: r.refundAmount != null ? Number(new Prisma.Decimal(r.refundAmount.toString()).toDecimalPlaces(2)) : 0,
        taxRefunded: r.taxRefunded != null ? Number(new Prisma.Decimal(r.taxRefunded.toString()).toDecimalPlaces(2)) : 0,
      })),
      payments: (sale.payments || []).map((p: any) => ({
        ...p,
        amount: p.amount != null ? Number(new Prisma.Decimal(p.amount.toString()).toDecimalPlaces(2)) : 0,
        amountTendered: p.amountTendered != null ? Number(new Prisma.Decimal(p.amountTendered.toString()).toDecimalPlaces(2)) : null,
        change: p.change != null ? Number(new Prisma.Decimal(p.change.toString()).toDecimalPlaces(2)) : 0,
        exchangeRate: p.exchangeRate != null ? Number(new Prisma.Decimal(p.exchangeRate.toString()).toDecimalPlaces(4)) : 1,
        amountBase: p.amountBase != null ? Number(new Prisma.Decimal(p.amountBase.toString()).toDecimalPlaces(2)) : 0,
      })),
    };
  }

  async create(dto: CreateSaleDto, businessId: string, cashierId: string, userRole?: string) {
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

      const policies = await this.policiesService.get(businessId);

      let subtotal = 0;
      let hasNegativeStock = false;
      const processedItems: any[] = [];

      for (const item of dto.items) {
        if (item.productId) {
          const product = await tx.product.findFirst({
            where: { id: item.productId, businessId },
            include: {
              recipeComponents: {
                include: {
                  componentProduct: true,
                },
              },
            },
          });
          if (!product) throw new NotFoundException(`Producto ${item.productId} no encontrado`);
          const requestedQty = validateProductQuantity(product.unit, item.quantity, product.name);

          if (product.isRecipe && product.recipeComponents && product.recipeComponents.length > 0) {
            for (const comp of product.recipeComponents) {
              const compProd = comp.componentProduct;
              if (compProd && compProd.trackStock === true) {
                const compRequestedQty = round3(requestedQty * Number(comp.quantity));
                const compCurrentStock = Number(compProd.stock);
                if (compCurrentStock < compRequestedQty) {
                  if (!policies.allowNegativeStock && !dto.isOfflineSync) {
                    throw new UnprocessableEntityException({
                      statusCode: 422,
                      error: 'Unprocessable Entity',
                      code: 'INSUFFICIENT_STOCK',
                      message: {
                        code: 'INSUFFICIENT_STOCK',
                        message: `Stock insuficiente para "${compProd.name}" (insumo de "${product.name}"). Disponible: ${compCurrentStock}, solicitado: ${compRequestedQty}`,
                        details: {
                          productId: compProd.id,
                          productName: compProd.name,
                          recipeProductId: product.id,
                          recipeProductName: product.name,
                          available: compCurrentStock,
                          requested: compRequestedQty,
                        },
                      },
                      details: {
                        productId: compProd.id,
                        productName: compProd.name,
                        recipeProductId: product.id,
                        recipeProductName: product.name,
                        available: compCurrentStock,
                        requested: compRequestedQty,
                      },
                    });
                  }
                  hasNegativeStock = true;
                }
              }
            }
          } else if (product.trackStock === true) {
            const currentStock = Number(product.stock);
            if (currentStock < requestedQty) {
              if (!policies.allowNegativeStock && !dto.isOfflineSync) {
                throw new UnprocessableEntityException({
                  statusCode: 422,
                  error: 'Unprocessable Entity',
                  code: 'INSUFFICIENT_STOCK',
                  message: {
                    code: 'INSUFFICIENT_STOCK',
                    message: `Stock insuficiente para "${product.name}". Disponible: ${currentStock}, solicitado: ${requestedQty}`,
                    details: {
                      productId: product.id,
                      productName: product.name,
                      available: currentStock,
                      requested: requestedQty,
                    },
                  },
                  details: {
                    productId: product.id,
                    productName: product.name,
                    available: currentStock,
                    requested: requestedQty,
                  },
                });
              }
              hasNegativeStock = true;
            }
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

        // Candado de fila en cliente y empresa (convenio) para Cartera de Cobro
        await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customer.id} FOR UPDATE`;
        if (customer.groupId) {
          await tx.$queryRaw`SELECT id FROM pos_credit_groups WHERE id = ${customer.groupId} FOR UPDATE`;
        }

        const saleTotalDecimal = new Prisma.Decimal(total);

        // 1. Deuda activa del cliente
        const customerDebtAgg = await tx.creditAccount.aggregate({
          where: {
            customerId: customer.id,
            status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
          },
          _sum: { balance: true },
        });
        const customerDebt = customerDebtAgg._sum.balance ? Math.round(Number(customerDebtAgg._sum.balance) * 100) / 100 : 0;
        const customerDebtDecimal = new Prisma.Decimal(customerDebt);

        let isLimitExceeded = false;
        let exceededLimit = 0;
        let exceededBalance = 0;
        let isGroupExceeded = false;

        if (customer.creditLimit !== null && customer.creditLimit !== undefined) {
          const customerLimitDecimal = new Prisma.Decimal(customer.creditLimit);
          if (customerDebtDecimal.add(saleTotalDecimal).greaterThan(customerLimitDecimal)) {
            isLimitExceeded = true;
            exceededLimit = Number(customer.creditLimit);
            exceededBalance = customerDebt;
            isGroupExceeded = false;
          }
        }

        // 2. Deuda activa de la empresa (si el cliente pertenece a una con límite)
        if (!isLimitExceeded && customer.groupId) {
          const group = await tx.creditGroup.findFirst({
            where: { id: customer.groupId, businessId },
          });
          if (group && group.creditLimit !== null && group.creditLimit !== undefined) {
            const groupDebtAgg = await tx.creditAccount.aggregate({
              where: {
                customer: { groupId: customer.groupId },
                businessId,
                status: { in: [CreditAccountStatus.PENDING, CreditAccountStatus.PARTIALLY_PAID, CreditAccountStatus.OVERDUE] },
              },
              _sum: { balance: true },
            });
            const groupDebt = groupDebtAgg._sum.balance ? Math.round(Number(groupDebtAgg._sum.balance) * 100) / 100 : 0;
            const groupDebtDecimal = new Prisma.Decimal(groupDebt);
            const groupLimitDecimal = new Prisma.Decimal(group.creditLimit);

            if (groupDebtDecimal.add(saleTotalDecimal).greaterThan(groupLimitDecimal)) {
              isLimitExceeded = true;
              exceededLimit = Number(group.creditLimit);
              exceededBalance = groupDebt;
              isGroupExceeded = true;
            }
          }
        }

        if (isLimitExceeded) {
          const requiresApproval = policies.creditLimitOverrideRequiresApproval ?? true;
          let overrideApprovedById: string | null = null;

          if (requiresApproval) {
            if (userRole === UserRole.CAJERO || !dto.approvalToken) {
              if (dto.approvalToken) {
                overrideApprovedById = await this.approvalsService.consumeToken(
                  businessId,
                  PosAction.CREDIT_LIMIT_OVERRIDE,
                  dto.approvalToken,
                  tx,
                );
              } else {
                throw new UnprocessableEntityException({
                  statusCode: 422,
                  error: 'Unprocessable Entity',
                  code: 'CREDIT_LIMIT_EXCEEDED',
                  message: {
                    code: 'CREDIT_LIMIT_EXCEEDED',
                    message: `Límite de crédito excedido (${isGroupExceeded ? 'empresa' : 'cliente'}). Límite: ${exceededLimit.toFixed(2)}, Deuda actual: ${exceededBalance.toFixed(2)}, Intentando cargar: ${total.toFixed(2)}`,
                    details: {
                      limit: exceededLimit,
                      balance: exceededBalance,
                      requested: total,
                      entity: isGroupExceeded ? 'GROUP' : 'CUSTOMER',
                      entityId: isGroupExceeded ? customer.groupId : customer.id,
                    },
                  },
                  limit: exceededLimit,
                  balance: exceededBalance,
                  requested: total,
                });
              }
            } else {
              overrideApprovedById = dto.approvalToken
                ? await this.approvalsService.consumeToken(
                    businessId,
                    PosAction.CREDIT_LIMIT_OVERRIDE,
                    dto.approvalToken,
                    tx,
                  )
                : cashierId;
            }
          } else {
            overrideApprovedById = cashierId;
          }

          await this.auditService.record(
            {
              businessId,
              userId: overrideApprovedById || cashierId,
              userRole,
              action: PosAction.CREDIT_LIMIT_OVERRIDE,
              entityType: isGroupExceeded ? 'CreditGroup' : 'Customer',
              entityId: isGroupExceeded ? customer.groupId : customer.id,
              reason: `Venta a crédito autorizada sobrepasando límite de ${isGroupExceeded ? 'empresa' : 'cliente'} (${exceededLimit.toFixed(2)}). Solicitado: ${total.toFixed(2)}, Deuda previa: ${exceededBalance.toFixed(2)}`,
            },
            tx,
          );
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

      const enabledMethods = policies.paymentMethodsEnabled.split(',');

      let paymentsPayload = dto.payments;
      if (!paymentsPayload || paymentsPayload.length === 0) {
        // Fallback for older clients
        const tendered = dto.amountPaid != null ? dto.amountPaid : total;
        paymentsPayload = [{
          method: paymentMethod || PosPaymentMethod.EFECTIVO,
          amount: total,
          amountTendered: tendered,
          reference: dto.reference
        }];
      }

      let totalBaseTenderedDec = new Prisma.Decimal(0);
      let mainMethod = paymentsPayload.length === 1 ? paymentsPayload[0].method : PosPaymentMethod.MIXTO;

      const processedPayments = [];
      for (const p of paymentsPayload) {
        const currency = (p.currency || business.currency || 'NIO').toUpperCase();

        if (currency !== 'NIO') {
          if (!policies.multiCurrencyEnabled) {
            throw new BadRequestException({
              statusCode: 400,
              error: 'Bad Request',
              code: 'CURRENCY_NOT_ALLOWED',
              message: {
                code: 'CURRENCY_NOT_ALLOWED',
                message: 'El cobro multimoneda no está habilitado en este negocio',
              },
            });
          }
          const acceptedList = (policies.acceptedCurrencies || 'NIO')
            .split(',')
            .map((c) => c.trim().toUpperCase());
          if (!acceptedList.includes(currency)) {
            throw new BadRequestException({
              statusCode: 400,
              error: 'Bad Request',
              code: 'CURRENCY_NOT_ACCEPTED',
              message: {
                code: 'CURRENCY_NOT_ACCEPTED',
                message: `La moneda ${currency} no está aceptada por el negocio`,
              },
            });
          }
          if (
            p.method === PosPaymentMethod.TARJETA ||
            p.method === PosPaymentMethod.TRANSFERENCIA ||
            p.method === PosPaymentMethod.CREDITO
          ) {
            throw new BadRequestException({
              statusCode: 400,
              error: 'Bad Request',
              code: 'CURRENCY_NOT_ALLOWED_FOR_METHOD',
              message: {
                code: 'CURRENCY_NOT_ALLOWED_FOR_METHOD',
                message: `El método de pago ${p.method} solo se acepta en NIO`,
              },
            });
          }
        }

        if (!enabledMethods.includes(p.method) && p.method !== PosPaymentMethod.CREDITO) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'PAYMENT_METHOD_DISABLED',
            message: {
              code: 'PAYMENT_METHOD_DISABLED',
              message: `El método de pago ${p.method} no está habilitado`,
            },
          });
        }

        let appliedRate = new Prisma.Decimal(1);
        if (currency === 'USD') {
          const activeRateData = await this.exchangeRateService.getCurrentRate(businessId);
          appliedRate = new Prisma.Decimal(activeRateData.rate.toString());

          if (p.exchangeRate) {
            if (dto.isOfflineSync) {
              const isValidOffline = await this.exchangeRateService.validateOfflineRate(
                businessId,
                Number(p.exchangeRate),
                dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
              );
              if (isValidOffline) {
                appliedRate = new Prisma.Decimal(p.exchangeRate.toString());
              } else {
                hasAuditDiscrepancy = true;
                auditNote += ` [Tasa offline ${p.exchangeRate} recalculada con vigente ${appliedRate.toFixed(4)}]`;
              }
            } else {
              if (!new Prisma.Decimal(p.exchangeRate.toString()).equals(appliedRate)) {
                hasAuditDiscrepancy = true;
                auditNote += ` [Tasa online snapshot ignorada. Vigente: ${appliedRate.toFixed(4)}]`;
              }
            }
          }
        }

        let pTenderedDec: Prisma.Decimal;
        let pAmtDec: Prisma.Decimal;

        if (p.amountTendered !== undefined && p.amountTendered !== null) {
          pTenderedDec = new Prisma.Decimal(p.amountTendered.toString());
          pAmtDec = (p.amount !== undefined && p.amount !== null)
            ? new Prisma.Decimal(p.amount.toString())
            : pTenderedDec;
        } else if (p.amount !== undefined && p.amount !== null) {
          pAmtDec = new Prisma.Decimal(p.amount.toString());
          pTenderedDec = pAmtDec;
        } else {
          pTenderedDec = new Prisma.Decimal(0);
          pAmtDec = new Prisma.Decimal(0);
        }

        if (p.method !== PosPaymentMethod.EFECTIVO) {
          pTenderedDec = pAmtDec;
        }

        if (currency === 'USD' && pAmtDec.greaterThan(pTenderedDec)) {
          pAmtDec = pTenderedDec;
        }

        const amountBaseDec = pTenderedDec.times(appliedRate).toDecimalPlaces(2);

        if (p.method === PosPaymentMethod.TARJETA && policies.requireReferenceCard && !p.reference) {
          throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'PAYMENT_REFERENCE_REQUIRED', message: { code: 'PAYMENT_REFERENCE_REQUIRED', message: 'Referencia requerida para pago con tarjeta' } });
        }
        if (p.method === PosPaymentMethod.TRANSFERENCIA && policies.requireReferenceTransfer && !p.reference) {
          throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'PAYMENT_REFERENCE_REQUIRED', message: { code: 'PAYMENT_REFERENCE_REQUIRED', message: 'Referencia requerida para pago con transferencia' } });
        }

        const safeReference = p.reference ? p.reference.toString().substring(0, 50).trim() : null;

        totalBaseTenderedDec = totalBaseTenderedDec.plus(amountBaseDec);

        processedPayments.push({
          method: p.method,
          amount: pAmtDec,
          amountTendered: pTenderedDec,
          change: new Prisma.Decimal(0),
          reference: safeReference,
          currency,
          exchangeRate: appliedRate,
          amountBase: amountBaseDec,
          shiftId: cashRegisterId,
          createdById: cashierId,
        });
      }

      const expectedTotalDec = new Prisma.Decimal(total.toString());
      if (totalBaseTenderedDec.lessThan(expectedTotalDec)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'PAYMENT_TOTAL_MISMATCH',
          message: {
            code: 'PAYMENT_TOTAL_MISMATCH',
            message: `La suma de los pagos (${totalBaseTenderedDec.toFixed(2)}) no coincide con el total de la venta (${expectedTotalDec.toFixed(2)})`,
          },
        });
      }

      const totalChangeDec = totalBaseTenderedDec.minus(expectedTotalDec);

      if (totalChangeDec.greaterThan(0)) {
        const cashPayments = processedPayments.filter((p) => p.method === PosPaymentMethod.EFECTIVO);
        if (cashPayments.length === 0) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'PAYMENT_TOTAL_MISMATCH',
            message: {
              code: 'PAYMENT_TOTAL_MISMATCH',
              message: 'El vuelto solo se permite si hay pagos en efectivo',
            },
          });
        }

        let remainingChange = new Prisma.Decimal(totalChangeDec.toString());
        for (let i = cashPayments.length - 1; i >= 0 && remainingChange.greaterThan(0); i--) {
          const cp = cashPayments[i];
          const cpTenderedBase = cp.amountTendered.times(cp.exchangeRate).toDecimalPlaces(2);
          const changeForThis = Prisma.Decimal.min(remainingChange, cpTenderedBase);

          cp.change = changeForThis;
          const appliedBase = cpTenderedBase.minus(changeForThis);
          cp.amountBase = appliedBase;
          cp.amount = appliedBase.dividedBy(cp.exchangeRate).toDecimalPlaces(2);

          remainingChange = remainingChange.minus(changeForThis);
        }
      } else {
        for (const p of processedPayments) {
          p.amountBase = p.amount.times(p.exchangeRate).toDecimalPlaces(2);
        }
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
          tableNumber: dto.tableNumber || null,
          zoneName: dto.zoneName || null,
          waiterName: dto.waiterName || null,
          vehicleInfo: dto.vehicleInfo || null,
          workshopVehicleId: dto.workshopVehicleId || null,
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
          amountPaid: Number(totalBaseTenderedDec.toDecimalPlaces(2)),
          change: totalChangeDec,
          reference: dto.reference || null,
          notes: finalNotes || null,
          hasNegativeStock,
          status: "COMPLETED",
          occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        },
        include: { items: true, payments: true, cashier: { select: { name: true } }, customer: true },
      });

      if (hasNegativeStock) {
        await tx.posAuditLog.create({
          data: {
            businessId,
            userId: cashierId,
            userRole: 'CAJERO',
            action: 'VENTA_STOCK_NEGATIVO',
            entityType: 'Sale',
            entityId: sale.id,
            reason: 'Venta realizada con stock negativo permitido por política',
            after: { invoiceNumber, total, items: processedItems },
          },
        });
      }

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
          const product = await tx.product.findUnique({
            where: { id: item.productId },
            include: {
              recipeComponents: {
                include: {
                  componentProduct: true,
                },
              },
            },
          });
          if (product?.isRecipe && product.recipeComponents && product.recipeComponents.length > 0) {
            const lineQty = round3(item.quantity);
            for (const comp of product.recipeComponents) {
              const compProd = comp.componentProduct;
              if (compProd?.trackStock) {
                const deductQty = round3(lineQty * Number(comp.quantity));
                const currentComp = await tx.product.findUnique({ where: { id: compProd.id } });
                const stockBefore = currentComp ? Number(currentComp.stock) : 0;
                const stockAfter = round3(stockBefore - deductQty);

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
                    stockBefore,
                    stockAfter,
                    concept: `Consumo receta: ${product.name}`,
                    reference: sale.id,
                  },
                });
              }
            }
          } else if (product?.trackStock) {
            const qty = round3(item.quantity);
            const stockBefore = Number(product.stock);
            const stockAfter = round3(stockBefore - qty);
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
                stockBefore,
                stockAfter,
                concept: stockAfter < 0 ? `Venta ${invoiceNumber} (Stock Negativo)` : `Venta ${invoiceNumber}`,
                reference: sale.id,
              },
            });
          }
        }
      }

      this.logger.log(`[create] Venta: ${invoiceNumber} total=${total.toFixed(2)} metodo=${mainMethod} negocio=${businessId}`);
      return this.formatSale(sale, userRole);
    });
  }

  async findAll(
    businessId: string,
    filters?: { from?: string; to?: string; status?: string; paymentMethod?: string; cashRegisterId?: string },
    userRole?: string,
  ) {
    const where: any = { businessId };
    if (filters?.status) {
      if (filters.status === 'CANCELLED' || filters.status === 'VOIDED') {
        where.status = { in: ['CANCELLED', 'VOIDED'] };
      } else {
        where.status = filters.status;
      }
    }
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

    const sales = await this.prisma.sale.findMany({
      where,
      include: {
        items: true,
        cashier: { select: { id: true, name: true } },
        cashRegister: { select: { id: true, openedAt: true } },
        payments: true,
        returns: {
          include: { items: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return sales.map(s => this.formatSale(s, userRole));
  }

  async findOne(id: string, businessId: string, userRole?: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                price: true,
                barcode: true,
              },
            },
          },
        },
        cashier: { select: { id: true, name: true } },
        cashRegister: { select: { id: true, openedAt: true } },
        payments: true,
        returns: {
          include: {
            items: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!sale) throw new NotFoundException("Venta no encontrada");
    return this.formatSale(sale, userRole);
  }

  private async findOpenShiftForRefund(
    tx: any,
    businessId: string,
    executorUserId: string,
    approvedById?: string | null,
  ) {
    // 1. Turno abierto del usuario que ejecuta
    let openShift = await tx.cashRegister.findFirst({
      where: { businessId, cashierId: executorUserId, status: 'OPEN' },
      select: { id: true },
    });
    // 2. Si no tiene, el del encargado que aprobó (si existe y tiene uno abierto)
    if (!openShift && approvedById) {
      openShift = await tx.cashRegister.findFirst({
        where: { businessId, cashierId: approvedById, status: 'OPEN' },
        select: { id: true },
      });
    }
    return openShift;
  }

  async voidSale(
    id: string,
    businessId: string,
    userId: string,
    userRole: string,
    dto: { reason: string; approvalToken?: string },
  ) {
    if (!dto.reason || !dto.reason.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VOID_REASON_REQUIRED',
        message: { code: 'VOID_REASON_REQUIRED', message: 'El motivo de anulación es obligatorio' },
      });
    }

    const policies = await this.policiesService.get(businessId);
    if (policies.voidsCompletedEnabled === false) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'VOIDS_DISABLED',
        message: { code: 'VOIDS_DISABLED', message: 'La anulación de ventas está deshabilitada en este negocio.' },
      });
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Lock sale row
      await tx.$queryRaw`SELECT id FROM pos_sales WHERE id = ${id} FOR UPDATE`;

      let approvedById: string | null = null;
      if (policies.voidsRequireApproval) {
        if (userRole === UserRole.CAJERO) {
          approvedById = await this.approvalsService.consumeToken(
            businessId,
            PosAction.ANULAR_VENTA_COBRADA,
            dto.approvalToken,
            tx,
          );
        } else {
          approvedById = dto.approvalToken
            ? await this.approvalsService.consumeToken(
                businessId,
                PosAction.ANULAR_VENTA_COBRADA,
                dto.approvalToken,
                tx,
              )
            : userId;
        }
      } else {
        approvedById = userId;
      }

      const sale = await tx.sale.findFirst({
        where: { id, businessId },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  price: true,
                  barcode: true,
                  trackStock: true,
                  isRecipe: true,
                  recipeComponents: {
                    include: {
                      componentProduct: {
                        select: {
                          id: true,
                          name: true,
                          stock: true,
                          trackStock: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          payments: true,
          returns: true,
          creditAccount: true,
        },
      });

      if (!sale) throw new NotFoundException('Venta no encontrada');

      // Bloqueo si la venta pertenece a un corte congelado o liquidado
      const statementItem = await tx.creditStatementItem.findFirst({
        where: { saleId: id },
        include: { statement: true },
      });
      if (
        statementItem &&
        ['OPEN', 'PARTIALLY_SETTLED', 'SETTLED'].includes(statementItem.statement.status)
      ) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'STATEMENT_CLOSED',
          message: {
            code: 'STATEMENT_CLOSED',
            message: `La venta pertenece al corte "${statementItem.statement.statementNumber || statementItem.statement.id}" (${statementItem.statement.status}) y no puede anularse sin reabrir el corte`,
          },
        });
      }

      if (sale.status === 'VOIDED' || sale.status === 'CANCELLED') {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'SALE_ALREADY_VOIDED',
          message: { code: 'SALE_ALREADY_VOIDED', message: 'La venta ya ha sido anulada previamente.' },
        });
      }

      if (sale.returns && sale.returns.length > 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'SALE_HAS_RETURNS',
          message: { code: 'SALE_HAS_RETURNS', message: 'La venta tiene devoluciones previas; debe devolverse el resto en lugar de anular.' },
        });
      }

      if (sale.status !== 'COMPLETED') {
        throw new BadRequestException('Solo se pueden anular ventas completadas');
      }

      // 2. Stock replenishment
      for (const item of sale.items) {
        if (item.productId && item.product?.isRecipe && item.product.recipeComponents && item.product.recipeComponents.length > 0) {
          const lineQty = round3(item.quantity);
          for (const comp of item.product.recipeComponents) {
            const compProd = comp.componentProduct;
            if (compProd?.trackStock) {
              const returnQty = round3(lineQty * Number(comp.quantity));
              const currentComp = await tx.product.findUnique({ where: { id: compProd.id } });
              const stockBefore = currentComp ? Number(currentComp.stock) : 0;
              const stockAfter = round3(stockBefore + returnQty);

              await tx.product.update({
                where: { id: compProd.id },
                data: { stock: { increment: returnQty } },
              });

              await tx.stockMovement.create({
                data: {
                  businessId,
                  productId: compProd.id,
                  userId,
                  type: 'DEVOLUCION',
                  quantity: returnQty,
                  stockBefore,
                  stockAfter,
                  concept: `Reposición receta: ${item.productName || item.product.name}`,
                  reference: sale.id,
                },
              });
            }
          }
        } else if (item.productId && item.product?.trackStock) {
          const qty = round3(item.quantity);
          const currentProd = await tx.product.findUnique({ where: { id: item.productId } });
          const stockBefore = currentProd ? Number(currentProd.stock) : 0;
          const stockAfter = round3(stockBefore + qty);

          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: qty } },
          });

          await tx.stockMovement.create({
            data: {
              businessId,
              productId: item.productId,
              userId,
              type: 'DEVOLUCION',
              quantity: qty,
              stockBefore,
              stockAfter,
              concept: `Anulación venta ${sale.invoiceNumber}`,
              reference: sale.id,
            },
          });
        }
      }

      // 3. Cash / Payments reversal
      let netCashPaidDec = new Prisma.Decimal(0);
      if (sale.payments && sale.payments.length > 0) {
        for (const p of sale.payments) {
          if (p.method === PosPaymentMethod.EFECTIVO) {
            const tendered = new Prisma.Decimal(p.amountTendered != null ? p.amountTendered.toString() : p.amount.toString());
            const change = new Prisma.Decimal(p.change != null ? p.change.toString() : 0);
            const isUsd = (p.currency || '').toUpperCase() === 'USD';
            if (isUsd) {
              const rate = new Prisma.Decimal(p.exchangeRate != null ? p.exchangeRate.toString() : 1);
              const baseTendered = p.amountBase != null 
                ? new Prisma.Decimal(p.amountBase.toString())
                : tendered.times(rate).toDecimalPlaces(2);
              netCashPaidDec = netCashPaidDec.plus(baseTendered.minus(change));
            } else {
              netCashPaidDec = netCashPaidDec.plus(tendered.minus(change));
            }
          }
        }
      } else if (sale.paymentMethod === PosPaymentMethod.EFECTIVO) {
        netCashPaidDec = new Prisma.Decimal(sale.total != null ? sale.total.toString() : 0);
      }

      let cashRefundMovement: any = null;
      if (netCashPaidDec.greaterThan(0)) {
        const openShift = await this.findOpenShiftForRefund(tx, businessId, userId, approvedById);
        if (!openShift) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            error: 'Unprocessable Entity',
            code: 'NO_OPEN_SHIFT',
            message: {
              code: 'NO_OPEN_SHIFT',
              message: 'No hay turno abierto del cajero ni del aprobador para registrar la salida de efectivo de la anulación.',
            },
          });
        }

        cashRefundMovement = await tx.cashMovement.create({
          data: {
            businessId,
            cashRegisterId: openShift.id,
            userId,
            type: 'SALIDA',
            amount: netCashPaidDec,
            concept: `Anulación venta ${sale.invoiceNumber}`,
            currency: 'NIO',
            exchangeRate: new Prisma.Decimal(1),
            amountBase: netCashPaidDec,
          },
        });
      }

      // 4. Credit account reversal
      let creditRefundMovement: any = null;
      if (sale.creditAccount) {
        const creditPayments = await tx.creditPayment.findMany({
          where: { creditAccountId: sale.creditAccount.id },
        });
        const totalAbonosPaidDec = creditPayments.reduce(
          (sum: Prisma.Decimal, cp: any) => sum.plus(new Prisma.Decimal(cp.amount != null ? cp.amount.toString() : 0)),
          new Prisma.Decimal(0),
        );

        // Si el cliente ya hizo abonos, se le deben reembolsar en efectivo en el turno abierto actual
        if (totalAbonosPaidDec.greaterThan(0)) {
          const openShift = await this.findOpenShiftForRefund(tx, businessId, userId, approvedById);
          if (!openShift) {
            throw new UnprocessableEntityException({
              statusCode: 422,
              error: 'Unprocessable Entity',
              code: 'NO_OPEN_SHIFT',
              message: {
                code: 'NO_OPEN_SHIFT',
                message: 'No hay turno abierto del cajero ni del aprobador para registrar el reembolso en efectivo de los abonos ya pagados del crédito.',
              },
            });
          }

          creditRefundMovement = await tx.cashMovement.create({
            data: {
              businessId,
              cashRegisterId: openShift.id,
              userId,
              type: 'SALIDA',
              amount: totalAbonosPaidDec,
              concept: `Reembolso abonos cliente por anulación crédito venta ${sale.invoiceNumber}`,
              currency: 'NIO',
              exchangeRate: new Prisma.Decimal(1),
              amountBase: totalAbonosPaidDec,
            },
          });
        }

        await tx.creditAccount.update({
          where: { id: sale.creditAccount.id },
          data: {
            balance: 0,
            status: CreditAccountStatus.CANCELLED,
          },
        });
      }

      // 5. Update Sale status
      const updatedSale = await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: 'CANCELLED',
          voidedAt: new Date(),
          voidedById: userId,
          voidReason: dto.reason.trim(),
          voidApprovedById: approvedById,
          notes: dto.reason.trim() ? `${sale.notes ? sale.notes + '. ' : ''}[ANULADA: ${dto.reason.trim()}]` : sale.notes,
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  price: true,
                  barcode: true,
                },
              },
            },
          },
          payments: true,
          returns: { include: { items: true } },
          cashier: { select: { id: true, name: true } },
          cashRegister: { select: { id: true, openedAt: true } },
        },
      });

      // 6. Audit Log
      await this.auditService.record(
        {
          businessId,
          userId,
          userRole,
          action: 'SALE_VOIDED',
          entityType: 'Sale',
          entityId: sale.id,
          before: { status: sale.status },
          after: { status: 'CANCELLED', reason: dto.reason.trim() },
          reason: dto.reason.trim(),
          approvedById: approvedById || undefined,
        },
        tx as any,
      );

      this.logger.log(`[voidSale] Venta anulada: ${sale.invoiceNumber} businessId=${businessId}`);
      const formatted = this.formatSale(updatedSale, userRole);
      if (cashRefundMovement) {
        (formatted as any).cashRefundMovement = {
          id: cashRefundMovement.id,
          cashRegisterId: cashRefundMovement.cashRegisterId,
          type: cashRefundMovement.type,
          amount: Number(cashRefundMovement.amount),
          currency: cashRefundMovement.currency,
          amountBase: Number(cashRefundMovement.amountBase),
          concept: cashRefundMovement.concept,
        };
      } else if (creditRefundMovement) {
        (formatted as any).cashRefundMovement = {
          id: creditRefundMovement.id,
          cashRegisterId: creditRefundMovement.cashRegisterId,
          type: creditRefundMovement.type,
          amount: Number(creditRefundMovement.amount),
          currency: creditRefundMovement.currency,
          amountBase: Number(creditRefundMovement.amountBase),
          concept: creditRefundMovement.concept,
        };
      }
      return formatted;
    });
  }

  async cancel(id: string, businessId: string, dto: CancelSaleDto) {
    return this.voidSale(id, businessId, 'system', UserRole.ENCARGADO, {
      reason: dto.reason || 'Cancelación de venta',
      approvalToken: dto.approvalToken,
    });
  }

  async createReturn(
    id: string,
    businessId: string,
    userId: string,
    userRole: string,
    dto: CreateReturnDto,
  ) {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'RETURN_ITEMS_REQUIRED',
        message: { code: 'RETURN_ITEMS_REQUIRED', message: 'Debe especificar al menos un ítem a devolver.' },
      });
    }

    const policies = await this.policiesService.get(businessId);
    if (policies.returnsEnabled === false) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'RETURNS_DISABLED',
        message: { code: 'RETURNS_DISABLED', message: 'Las devoluciones están deshabilitadas en este negocio.' },
      });
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Lock sale row and items
      await tx.$queryRaw`SELECT id FROM pos_sales WHERE id = ${id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id, "returnedQty" FROM pos_sale_items WHERE "saleId" = ${id} FOR UPDATE`;

      const sale = await tx.sale.findFirst({
        where: { id, businessId },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  price: true,
                  barcode: true,
                  trackStock: true,
                  isRecipe: true,
                  recipeComponents: {
                    include: {
                      componentProduct: {
                        select: {
                          id: true,
                          name: true,
                          stock: true,
                          trackStock: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          payments: true,
          returns: { include: { items: true } },
          creditAccount: true,
        },
      });

      if (!sale) throw new NotFoundException('Venta no encontrada');

      // Bloqueo si la venta pertenece a un corte congelado o liquidado
      const statementItem = await tx.creditStatementItem.findFirst({
        where: { saleId: id },
        include: { statement: true },
      });
      if (
        statementItem &&
        ['OPEN', 'PARTIALLY_SETTLED', 'SETTLED'].includes(statementItem.statement.status)
      ) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'STATEMENT_CLOSED',
          message: {
            code: 'STATEMENT_CLOSED',
            message: `La venta pertenece al corte "${statementItem.statement.statementNumber || statementItem.statement.id}" (${statementItem.statement.status}) y no puede devolverse sin reabrir el corte`,
          },
        });
      }

      if (sale.status === 'VOIDED' || sale.status === 'CANCELLED') {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'SALE_ALREADY_VOIDED',
          message: { code: 'SALE_ALREADY_VOIDED', message: 'No se puede devolver una venta anulada.' },
        });
      }

      if (sale.status === 'RETURNED' || sale.status === 'REFUNDED') {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'RETURN_QTY_EXCEEDED',
          message: { code: 'RETURN_QTY_EXCEEDED', message: 'La venta ya fue devuelta en su totalidad.' },
        });
      }

      // Check return window
      const saleAgeDays = (Date.now() - sale.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const isExpiredWindow = policies.returnsMaxDays > 0 && saleAgeDays > policies.returnsMaxDays;
      if (isExpiredWindow && !dto.approvalToken) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'RETURN_WINDOW_EXPIRED',
          message: {
            code: 'RETURN_WINDOW_EXPIRED',
            message: `El plazo máximo para devoluciones (${policies.returnsMaxDays} días) ha expirado. Requiere aprobación de encargado.`,
          },
        });
      }

      // Approval validation
      let approvedById: string | null = null;
      if (policies.returnsRequireApproval || isExpiredWindow) {
        if (userRole === UserRole.CAJERO || isExpiredWindow) {
          approvedById = await this.approvalsService.consumeToken(
            businessId,
            PosAction.DEVOLUCION,
            dto.approvalToken,
            tx,
          );
        } else {
          approvedById = dto.approvalToken
            ? await this.approvalsService.consumeToken(
                businessId,
                PosAction.DEVOLUCION,
                dto.approvalToken,
                tx,
              )
            : userId;
        }
      } else {
        approvedById = userId;
      }

      const saleItemsMap = new Map<string, any>(sale.items.map((i: any) => [i.id, i]));
      const returnLinesData: any[] = [];
      let totalReturnRefundDec = new Prisma.Decimal(0);
      let totalReturnTaxDec = new Prisma.Decimal(0);

      const previousRefundsTotalDec = (sale.returns || []).reduce(
        (sum: Prisma.Decimal, r: any) => sum.plus(new Prisma.Decimal(r.refundAmount != null ? r.refundAmount.toString() : 0)),
        new Prisma.Decimal(0),
      );
      const remainingSaleRefundableDec = new Prisma.Decimal(sale.total.toString()).minus(previousRefundsTotalDec);

      for (const itemInput of dto.items) {
        const saleItem = saleItemsMap.get(itemInput.saleItemId);
        if (!saleItem) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'ITEM_NOT_FOUND',
            message: { code: 'ITEM_NOT_FOUND', message: `Ítem de venta no encontrado: ${itemInput.saleItemId}` },
          });
        }

        const currentlyReturned = saleItem.returnedQty || 0;
        const availableQty = saleItem.quantity - currentlyReturned;
        if (itemInput.qty > availableQty || itemInput.qty <= 0) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            error: 'Unprocessable Entity',
            code: 'RETURN_QTY_EXCEEDED',
            message: {
              code: 'RETURN_QTY_EXCEEDED',
              message: `Cantidad a devolver (${itemInput.qty}) excede lo disponible (${availableQty}) para ${saleItem.productName}.`,
            },
          });
        }

        // Calculation of line refund with proration and tax snapshot
        const returningQtyDec = new Prisma.Decimal(itemInput.qty.toString());
        const lineBaseSubtotalDec = new Prisma.Decimal(saleItem.unitPrice.toString()).times(returningQtyDec);

        const saleSubtotalDec = new Prisma.Decimal(sale.subtotal.toString());
        const saleDiscountDec = new Prisma.Decimal(sale.discountAmount.toString());
        let proratedDiscountDec = new Prisma.Decimal(0);
        if (saleSubtotalDec.greaterThan(0) && saleDiscountDec.greaterThan(0)) {
          proratedDiscountDec = lineBaseSubtotalDec.dividedBy(saleSubtotalDec).times(saleDiscountDec).toDecimalPlaces(2);
        }

        const netBaseDec = lineBaseSubtotalDec.minus(proratedDiscountDec);

        let lineTaxDec = new Prisma.Decimal(0);
        let lineRefundDec = new Prisma.Decimal(0);

        if (sale.taxEnabled && sale.taxRate > 0) {
          const rateDec = new Prisma.Decimal(sale.taxRate.toString()).dividedBy(100);
          if (sale.taxIncluded) {
            lineTaxDec = netBaseDec.minus(netBaseDec.dividedBy(new Prisma.Decimal(1).plus(rateDec))).toDecimalPlaces(2);
            lineRefundDec = netBaseDec.toDecimalPlaces(2);
          } else {
            lineTaxDec = netBaseDec.times(rateDec).toDecimalPlaces(2);
            lineRefundDec = netBaseDec.plus(lineTaxDec).toDecimalPlaces(2);
          }
        } else {
          lineRefundDec = netBaseDec.toDecimalPlaces(2);
        }

        totalReturnRefundDec = totalReturnRefundDec.plus(lineRefundDec);
        totalReturnTaxDec = totalReturnTaxDec.plus(lineTaxDec);

        returnLinesData.push({
          saleItem,
          qty: itemInput.qty,
          restock: itemInput.restock !== false,
          discountProrated: Number(proratedDiscountDec),
          taxRate: sale.taxRate,
          taxIncluded: sale.taxIncluded,
          taxAmount: Number(lineTaxDec),
          refundAmount: Number(lineRefundDec),
        });
      }

      // Check if after this return, all items are 100% returned
      let allItemsFullyReturned = true;
      for (const item of sale.items) {
        const thisReturnItem = dto.items.find((i: any) => i.saleItemId === item.id);
        const addedQty = thisReturnItem ? thisReturnItem.qty : 0;
        const totalAfter = (item.returnedQty || 0) + addedQty;
        if (totalAfter < item.quantity) {
          allItemsFullyReturned = false;
          break;
        }
      }

      // Absorption of rounding cents on the final return of the sale
      if (allItemsFullyReturned) {
        if (!totalReturnRefundDec.equals(remainingSaleRefundableDec)) {
          totalReturnRefundDec = remainingSaleRefundableDec;
          if (returnLinesData.length > 0) {
            const othersSum = returnLinesData.slice(0, -1).reduce((s, l) => s.plus(new Prisma.Decimal(l.refundAmount)), new Prisma.Decimal(0));
            returnLinesData[returnLinesData.length - 1].refundAmount = Number(remainingSaleRefundableDec.minus(othersSum));
          }
        }
      } else {
        if (totalReturnRefundDec.greaterThan(remainingSaleRefundableDec)) {
          totalReturnRefundDec = remainingSaleRefundableDec;
        }
      }

      // Refund method compatibility check
      const refundMethod = (dto.refundMethod || '').toUpperCase() as PosPaymentMethod;
      let totalPaidInMethodDec = new Prisma.Decimal(0);

      if (refundMethod === PosPaymentMethod.EFECTIVO) {
        for (const p of sale.payments) {
          if (p.method === PosPaymentMethod.EFECTIVO) {
            const isUsd = (p.currency || '').toUpperCase() === 'USD';
            const tendered = new Prisma.Decimal(p.amountTendered != null ? p.amountTendered.toString() : p.amount.toString());
            const change = new Prisma.Decimal(p.change != null ? p.change.toString() : 0);
            if (isUsd) {
              const rate = new Prisma.Decimal(p.exchangeRate != null ? p.exchangeRate.toString() : 1);
              totalPaidInMethodDec = totalPaidInMethodDec.plus(tendered.times(rate).toDecimalPlaces(2).minus(change));
            } else {
              totalPaidInMethodDec = totalPaidInMethodDec.plus(tendered.minus(change));
            }
          }
        }
      } else if (refundMethod === PosPaymentMethod.CREDITO) {
        if (sale.creditAccount) {
          totalPaidInMethodDec = new Prisma.Decimal(sale.creditAccount.originalAmount.toString());
        }
      } else {
        for (const p of sale.payments) {
          if (p.method === refundMethod) {
            totalPaidInMethodDec = totalPaidInMethodDec.plus(new Prisma.Decimal(p.amountBase != null ? p.amountBase.toString() : p.amount.toString()));
          }
        }
      }

      const previouslyRefundedMethodDec = (sale.returns || [])
        .filter((r: any) => r.refundMethod === refundMethod)
        .reduce((s: Prisma.Decimal, r: any) => s.plus(new Prisma.Decimal(r.refundAmount.toString())), new Prisma.Decimal(0));

      const availableForMethodDec = totalPaidInMethodDec.minus(previouslyRefundedMethodDec);
      if (totalReturnRefundDec.greaterThan(availableForMethodDec)) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'REFUND_METHOD_NOT_ALLOWED',
          message: {
            code: 'REFUND_METHOD_NOT_ALLOWED',
            message: `El monto a reembolsar (${totalReturnRefundDec.toFixed(2)}) supera el saldo disponible pagado con ${refundMethod} (${availableForMethodDec.toFixed(2)}).`,
          },
        });
      }

      // Handle Cash Movement in current open shift if refundMethod === EFECTIVO
      let openShiftId: string | null = null;
      let returnCashMovement: any = null;
      let excessCashMovement: any = null;

      if (refundMethod === PosPaymentMethod.EFECTIVO && totalReturnRefundDec.greaterThan(0)) {
        const openShift = await this.findOpenShiftForRefund(tx, businessId, userId, approvedById);
        if (!openShift) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            error: 'Unprocessable Entity',
            code: 'NO_OPEN_SHIFT',
            message: {
              code: 'NO_OPEN_SHIFT',
              message: 'No hay turno abierto del cajero ni del aprobador para registrar la salida de efectivo de la devolución.',
            },
          });
        }
        openShiftId = openShift.id;
        returnCashMovement = await tx.cashMovement.create({
          data: {
            businessId,
            cashRegisterId: openShift.id,
            userId,
            type: 'SALIDA',
            amount: totalReturnRefundDec,
            concept: `Reembolso devolución venta ${sale.invoiceNumber}`,
            currency: 'NIO',
            exchangeRate: new Prisma.Decimal(1),
            amountBase: totalReturnRefundDec,
          },
        });
      }

      // Handle Credit Account if refundMethod === CREDITO
      if (refundMethod === PosPaymentMethod.CREDITO && sale.creditAccount) {
        const currentBalDec = new Prisma.Decimal(sale.creditAccount.balance.toString());
        if (totalReturnRefundDec.greaterThan(currentBalDec)) {
          // El refund supera el saldo pendiente (el cliente ya pagó parte).
          // El excedente se reembolsa al cliente en efectivo en el turno abierto actual.
          const excessRefundDec = totalReturnRefundDec.minus(currentBalDec);

          const openShift = await this.findOpenShiftForRefund(tx, businessId, userId, approvedById);
          if (!openShift) {
            throw new UnprocessableEntityException({
              statusCode: 422,
              error: 'Unprocessable Entity',
              code: 'NO_OPEN_SHIFT',
              message: {
                code: 'NO_OPEN_SHIFT',
                message: 'No hay turno abierto del cajero ni del aprobador para registrar el reembolso en efectivo del excedente sobre el crédito.',
              },
            });
          }
          if (!openShiftId) openShiftId = openShift.id;

          excessCashMovement = await tx.cashMovement.create({
            data: {
              businessId,
              cashRegisterId: openShift.id,
              userId,
              type: 'SALIDA',
              amount: excessRefundDec,
              concept: `Reembolso excedente crédito en efectivo venta ${sale.invoiceNumber}`,
              currency: 'NIO',
              exchangeRate: new Prisma.Decimal(1),
              amountBase: excessRefundDec,
            },
          });

          await tx.creditAccount.update({
            where: { id: sale.creditAccount.id },
            data: {
              balance: 0,
              status: CreditAccountStatus.CANCELLED,
            },
          });
        } else {
          // El refund es menor o igual al saldo pendiente
          const newBalDec = currentBalDec.minus(totalReturnRefundDec);
          await tx.creditAccount.update({
            where: { id: sale.creditAccount.id },
            data: {
              balance: Number(newBalDec),
              status: newBalDec.equals(0) ? CreditAccountStatus.PAID : CreditAccountStatus.PARTIALLY_PAID,
            },
          });
        }
      }

      // Restock and Stock Movements
      for (const line of returnLinesData) {
        const saleItem = line.saleItem;
        await tx.saleItem.update({
          where: { id: saleItem.id },
          data: { returnedQty: { increment: line.qty } },
        });

        if (saleItem.productId && saleItem.product?.isRecipe && saleItem.product.recipeComponents && saleItem.product.recipeComponents.length > 0) {
          const lineQty = round3(line.qty);
          for (const comp of saleItem.product.recipeComponents) {
            const compProd = comp.componentProduct;
            if (compProd?.trackStock) {
              const compQty = round3(lineQty * Number(comp.quantity));
              const currentProd = await tx.product.findUnique({ where: { id: compProd.id } });
              const stockBefore = currentProd ? Number(currentProd.stock) : 0;

              if (line.restock) {
                const stockAfter = round3(stockBefore + compQty);
                await tx.product.update({
                  where: { id: compProd.id },
                  data: { stock: { increment: compQty } },
                });
                await tx.stockMovement.create({
                  data: {
                    businessId,
                    productId: compProd.id,
                    userId,
                    type: 'DEVOLUCION',
                    quantity: compQty,
                    stockBefore,
                    stockAfter,
                    concept: `Devolución receta: ${saleItem.productName || saleItem.product.name}`,
                    reference: sale.id,
                  },
                });
              } else {
                await tx.stockMovement.create({
                  data: {
                    businessId,
                    productId: compProd.id,
                    userId,
                    type: 'AJUSTE',
                    quantity: 0,
                    stockBefore,
                    stockAfter: stockBefore,
                    concept: `Merma/daño devolución receta: ${saleItem.productName || saleItem.product.name}`,
                    reference: sale.id,
                  },
                });
              }
            }
          }
        } else if (saleItem.productId && saleItem.product?.trackStock) {
          const qty = round3(line.qty);
          const currentProd = await tx.product.findUnique({ where: { id: saleItem.productId } });
          const stockBefore = currentProd ? Number(currentProd.stock) : 0;

          if (line.restock) {
            const stockAfter = round3(stockBefore + qty);
            await tx.product.update({
              where: { id: saleItem.productId },
              data: { stock: { increment: qty } },
            });
            await tx.stockMovement.create({
              data: {
                businessId,
                productId: saleItem.productId,
                userId,
                type: 'DEVOLUCION',
                quantity: qty,
                stockBefore,
                stockAfter,
                concept: `Devolución venta ${sale.invoiceNumber}`,
                reference: sale.id,
              },
            });
          } else {
            await tx.stockMovement.create({
              data: {
                businessId,
                productId: saleItem.productId,
                userId,
                type: 'AJUSTE',
                quantity: 0,
                stockBefore,
                stockAfter: stockBefore,
                concept: `Merma/daño devolución venta ${sale.invoiceNumber}`,
                reference: sale.id,
              },
            });
          }
        }
      }

      const returnCount = await tx.saleReturn.count({ where: { businessId } });
      const returnNumber = `DEV-${String(returnCount + 1).padStart(4, '0')}`;

      const returnRecord = await tx.saleReturn.create({
        data: {
          saleId: sale.id,
          businessId,
          returnNumber,
          reason: dto.reason,
          notes: dto.notes || null,
          refundMethod,
          refundAmount: Number(totalReturnRefundDec),
          taxRefunded: Number(totalReturnTaxDec),
          createdById: userId,
          approvedById,
          shiftId: openShiftId,
          items: {
            create: returnLinesData.map((l: any) => ({
              saleItemId: l.saleItem.id,
              productId: l.saleItem.productId,
              productName: l.saleItem.productName,
              quantity: l.qty,
              unitPrice: l.saleItem.unitPrice,
              discountProrated: l.discountProrated,
              taxRate: l.taxRate,
              taxIncluded: l.taxIncluded,
              taxAmount: l.taxAmount,
              refundAmount: l.refundAmount,
              restock: l.restock,
            })),
          },
        },
        include: { items: true },
      });

      const nextSaleStatus = allItemsFullyReturned ? 'RETURNED' : 'PARTIALLY_RETURNED';
      await tx.sale.update({
        where: { id: sale.id },
        data: { status: nextSaleStatus },
      });

      await this.auditService.record(
        {
          businessId,
          userId,
          userRole,
          action: 'SALE_RETURNED',
          entityType: 'SaleReturn',
          entityId: returnRecord.id,
          reason: dto.reason,
          before: { status: sale.status },
          after: {
            status: nextSaleStatus,
            returnNumber,
            refundAmount: Number(totalReturnRefundDec),
            refundMethod,
          },
          approvedById: approvedById || undefined,
        },
        tx as any,
      );

      this.logger.log(`[createReturn] Devolución ${returnNumber} registrada para venta ${sale.invoiceNumber} (monto: ${totalReturnRefundDec.toFixed(2)})`);
      return {
        ...returnRecord,
        ...(returnCashMovement ? {
          cashMovement: {
            id: returnCashMovement.id,
            cashRegisterId: returnCashMovement.cashRegisterId,
            type: returnCashMovement.type,
            amount: Number(returnCashMovement.amount),
            currency: returnCashMovement.currency,
            concept: returnCashMovement.concept,
          },
        } : {}),
        ...(excessCashMovement ? {
          cashMovement: {
            id: excessCashMovement.id,
            cashRegisterId: excessCashMovement.cashRegisterId,
            type: excessCashMovement.type,
            amount: Number(excessCashMovement.amount),
            currency: excessCashMovement.currency,
            concept: excessCashMovement.concept,
          },
        } : {}),
      };
    });
  }

  async findReturns(
    businessId: string,
    filters?: { from?: string; to?: string; userId?: string; reason?: string; saleId?: string },
  ) {
    const where: any = { businessId };
    if (filters?.userId) where.createdById = filters.userId;
    if (filters?.reason) where.reason = filters.reason;
    if (filters?.saleId) where.saleId = filters.saleId;
    if (filters?.from || filters?.to) {
      where.createdAt = {};
      if (filters.from) {
        where.createdAt.gte = filters.from.includes('T') ? new Date(filters.from) : new Date(`${filters.from}T00:00:00.000Z`);
      }
      if (filters.to) {
        where.createdAt.lte = filters.to.includes('T') ? new Date(filters.to) : new Date(`${filters.to}T23:59:59.999Z`);
      }
    }

    return this.prisma.saleReturn.findMany({
      where,
      include: {
        items: true,
        sale: { select: { id: true, invoiceNumber: true, status: true, total: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
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
