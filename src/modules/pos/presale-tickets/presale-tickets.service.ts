import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { PoliciesService } from '../policies/policies.service';
import { AuditService } from '../audit/audit.service';
import {
  formatDateInTimezone,
  getEndOfDayInTimezone,
  parseLocalDateToUtc,
} from '../../../common/utils/date.util';
import { calculateSaleTotals } from '../sales/utils/sale-calculation.util';
import { round3 } from '../products/product-unit.util';
import { resolveLineUnitPrice } from '../sales/utils/pricing.util';
import { CreatePresaleTicketDto } from './dto/create-presale-ticket.dto';
import { UpdatePresaleItemsDto } from './dto/update-presale-items.dto';
import { ChargePresaleTicketDto } from './dto/charge-presale-ticket.dto';

function formatPresaleItem(item: any) {
  const currentPrice =
    item.product?.price != null
      ? Number(item.product.price)
      : Number(item.unitPrice);
  const { product, ...rest } = item;
  return {
    ...rest,
    quantity: Number(item.quantity),
    reservedQty: Number(item.reservedQty),
    unitPrice: Number(item.unitPrice),
    currentPrice,
    subtotal: Number(item.subtotal),
    discount: Number(item.discount || 0),
    taxRate: Number(item.taxRate || 0),
    listPrice: item.listPrice != null ? Number(item.listPrice) : null,
    listPriceDiscount:
      item.listPriceDiscount != null ? Number(item.listPriceDiscount) : 0,
  };
}

function formatTicketWithItems(ticket: any) {
  if (!ticket) return ticket;
  return {
    ...ticket,
    subtotal: Number(ticket.subtotal),
    discountAmount: Number(ticket.discountAmount || 0),
    taxAmount: Number(ticket.taxAmount),
    total: Number(ticket.total),
    listPriceTotal:
      ticket.listPriceTotal != null ? Number(ticket.listPriceTotal) : null,
    items: (ticket.items || []).map(formatPresaleItem),
  };
}

@Injectable()
export class PresaleTicketsService {
  private readonly logger = new Logger(PresaleTicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesService: SalesService,
    private readonly policiesService: PoliciesService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Crea un ticket por cobrar (preventa), reserva stock atómicamente y asigna número diario.
   */
  async create(
    businessId: string,
    user: { sub: string; name?: string; email?: string; role?: string },
    dto: CreatePresaleTicketDto,
  ) {
    // 1. Validar que el negocio tenga el modo activo
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        twoStepSaleEnabled: true,
        twoStepTicketTtlHours: true,
        wholesaleEnabled: true,
        tracksBatches: true,
        useListPrice: true,
        taxRate: true,
        taxEnabled: true,
        taxIncluded: true,
      },
    });

    if (!business || !business.twoStepSaleEnabled) {
      throw new BadRequestException(
        'La venta en dos pasos no está habilitada para este negocio',
      );
    }

    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('El ticket debe contener al menos un producto');
    }

    // 2. Idempotencia por clientRequestId
    if (dto.clientRequestId) {
      const existing = await this.prisma.presaleTicket.findUnique({
        where: {
          businessId_clientRequestId: {
            businessId,
            clientRequestId: dto.clientRequestId,
          },
        },
        include: {
          items: {
            include: {
              product: { select: { id: true, price: true, name: true } },
            },
          },
        },
      });
      if (existing) {
        return formatTicketWithItems(existing);
      }
    }

    const now = new Date();
    const businessDateStr = formatDateInTimezone(now, 'America/Managua');
    const businessDate = parseLocalDateToUtc(
      businessDateStr,
      '00:00:00.000',
      'America/Managua',
    );

    // 3. Vencimiento: min(now + ttlHours, fin del día operativo Managua)
    const ttlHours = business.twoStepTicketTtlHours || 4;
    const ttlExpiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
    const endOfDay = getEndOfDayInTimezone(businessDateStr, 'America/Managua');
    const expiresAt =
      ttlExpiresAt.getTime() < endOfDay.getTime() ? ttlExpiresAt : endOfDay;

    return this.prisma.$transaction(async (tx) => {
      // 4. Contador diario atómico
      const counterResult: any[] = await tx.$queryRaw`
        INSERT INTO pos_presale_counters ("businessId", "businessDate", "lastNumber")
        VALUES (${businessId}, ${businessDate}::date, 1)
        ON CONFLICT ("businessId", "businessDate")
        DO UPDATE SET "lastNumber" = pos_presale_counters."lastNumber" + 1
        RETURNING "lastNumber";
      `;
      const dailyNumber = Number(counterResult[0]?.lastNumber || 1);
      const displayNumber = `P-${String(dailyNumber).padStart(4, '0')}`;
      const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
      const scanCode = `TK-${displayNumber}-${randomSuffix}`;

      // 5. Reserva de stock atómica: ordenar IDs para evitar interbloqueos
      const requestedProductIds = Array.from(
        new Set(dto.items.map((i) => i.productId)),
      ).sort();

      // Bloquear productos principales
      await tx.$executeRaw`
        SELECT id FROM pos_products
        WHERE id = ANY(${requestedProductIds}::text[]) AND "businessId" = ${businessId}
        ORDER BY id FOR UPDATE;
      `;

      const products = await tx.product.findMany({
        where: { id: { in: requestedProductIds }, businessId },
        include: {
          recipeComponents: {
            include: { componentProduct: true },
          },
        },
      });

      const productMap = new Map(products.map((p) => [p.id, p]));

      // Bloquear también los componentes de recetas
      const recipeCompIds: string[] = [];
      for (const p of products) {
        if (p.isRecipe && p.recipeComponents) {
          for (const rc of p.recipeComponents) {
            if (rc.componentProductId) recipeCompIds.push(rc.componentProductId);
          }
        }
      }
      if (recipeCompIds.length > 0) {
        const sortedCompIds = Array.from(new Set(recipeCompIds)).sort();
        await tx.$executeRaw`
          SELECT id FROM pos_products
          WHERE id = ANY(${sortedCompIds}::text[]) AND "businessId" = ${businessId}
          ORDER BY id FOR UPDATE;
        `;
      }

      // Validar disponibilidad
      const policies = await this.policiesService.get(businessId, tx);
      const unavailableProducts: any[] = [];
      const stockReservationsToApply: Array<{ productId: string; qty: number }> = [];

      for (const item of dto.items) {
        const product = productMap.get(item.productId);
        if (!product) {
          throw new NotFoundException(`Producto ${item.productId} no encontrado`);
        }

        const requestedQty = Number(item.quantity);

        if (product.isRecipe && product.recipeComponents && product.recipeComponents.length > 0) {
          for (const comp of product.recipeComponents) {
            const compProd = comp.componentProduct;
            if (compProd && compProd.trackStock) {
              const compReqQty = round3(requestedQty * Number(comp.quantity));
              const compAvailable =
                Number(compProd.stock) - Number(compProd.reservedStock || 0);
              if (compAvailable < compReqQty && !policies.allowNegativeStock) {
                unavailableProducts.push({
                  productId: compProd.id,
                  productName: `${compProd.name} (insumo de ${product.name})`,
                  available: Math.max(0, compAvailable),
                  requested: compReqQty,
                });
              } else {
                stockReservationsToApply.push({
                  productId: compProd.id,
                  qty: compReqQty,
                });
              }
            }
          }
        } else if (product.trackStock) {
          const available = Number(product.stock) - Number(product.reservedStock || 0);
          if (available < requestedQty && !policies.allowNegativeStock) {
            unavailableProducts.push({
              productId: product.id,
              productName: product.name,
              available: Math.max(0, available),
              requested: requestedQty,
            });
          } else {
            stockReservationsToApply.push({
              productId: product.id,
              qty: requestedQty,
            });
          }
        }
      }

      if (unavailableProducts.length > 0) {
        throw new ConflictException({
          statusCode: 409,
          code: 'INSUFFICIENT_STOCK',
          message: 'Uno o más productos no tienen stock disponible para reservar',
          details: unavailableProducts,
        });
      }

      // Aplicar reservas de stock
      for (const r of stockReservationsToApply) {
        await tx.product.update({
          where: { id: r.productId },
          data: { reservedStock: { increment: r.qty } },
        });
      }

      // 6. Calcular totales y líneas de preventa
      const isSeller = user.role === UserRole.VENDEDOR;
      const isPrivileged =
        user.role === UserRole.ENCARGADO || user.role === UserRole.SUPERADMIN;

      const rawLinesForCalc = dto.items.map((item) => {
        const product = productMap.get(item.productId)!;
        const requestedQty = Number(item.quantity);
        const resolved = resolveLineUnitPrice(product, requestedQty, business);

        let unitPrice = resolved.unitPrice;
        if (item.unitPrice !== undefined && item.unitPrice !== null) {
          const clientPrice = Number(item.unitPrice);
          const diff = Math.abs(clientPrice - resolved.unitPrice);
          if (diff > 0.01) {
            if (isSeller) {
              // El vendedor no puede fijar precios: el servidor ignora el valor enviado y toma el vigente
              unitPrice = resolved.unitPrice;
            } else if (isPrivileged && policies.priceOverrideEnabled) {
              // Solo ENCARGADO o SUPERADMIN con política activa pueden cambiar precio
              unitPrice = clientPrice;
            } else {
              unitPrice = resolved.unitPrice;
            }
          } else {
            unitPrice = clientPrice;
          }
        }

        return {
          productId: product.id,
          productName: product.name,
          barcode: product.barcode || null,
          unitPrice,
          priceTier: resolved.priceTier,
          quantity: requestedQty,
          discount: item.discount || 0,
          listPrice:
            item.listPrice !== undefined
              ? Number(item.listPrice)
              : product.listPrice != null
              ? Number(product.listPrice)
              : null,
          taxable: item.taxable !== undefined ? Boolean(item.taxable) : Boolean(product.taxable),
        };
      });

      const totals = calculateSaleTotals(rawLinesForCalc, 0, business);

      const sellerName = user.name || user.email || 'Vendedor';

      // 7. Crear el ticket
      const ticket = await tx.presaleTicket.create({
        data: {
          businessId,
          number: dailyNumber,
          businessDate,
          displayNumber,
          scanCode,
          status: 'PENDING',
          sellerId: user.sub,
          sellerName,
          sellerDeviceId: dto.sellerDeviceId || null,
          customerId: dto.customerId || null,
          customerName: dto.customerName || null,
          notes: dto.notes || null,
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          taxAmount: totals.taxAmount,
          total: totals.total,
          listPriceTotal: totals.listPriceTotal,
          sentAt: now,
          expiresAt,
          clientRequestId: dto.clientRequestId || null,
          items: {
            create: totals.lines.map((l) => {
              const prod = productMap.get(l.productId!)!;
              const reservedQty = prod.trackStock ? l.quantity : 0;
              return {
                productId: l.productId,
                productName: l.productName,
                barcode: l.barcode,
                quantity: l.quantity,
                reservedQty,
                unitPrice: l.unitPrice,
                priceTier: l.priceTier,
                listPrice: l.listPrice,
                listPriceDiscount: l.listPriceDiscount,
                taxable: l.taxable,
                taxRate: l.taxRate,
                discount: l.discount,
                subtotal: l.subtotal,
                origin: 'SELLER',
              };
            }),
          },
          events: {
            create: {
              businessId,
              eventType: 'SENT',
              userId: user.sub,
              userRole: user.role || 'VENDEDOR',
              details: {
                displayNumber,
                itemCount: dto.items.length,
                total: totals.total,
              },
            },
          },
        },
        include: {
          items: {
            include: {
              product: { select: { id: true, price: true, name: true } },
            },
          },
        },
      });

      return formatTicketWithItems(ticket);
    });
  }

  /**
   * Consulta tickets pendientes (para la caja con polling liviano).
   * Ejecuta barrido perezoso de vencidos.
   */
  async findPending(businessId: string) {
    await this.sweepExpirations(businessId);

    const tickets = await this.prisma.presaleTicket.findMany({
      where: {
        businessId,
        status: 'PENDING',
      },
      include: {
        items: {
          where: { removedAt: null },
          include: {
            product: { select: { id: true, price: true, name: true } },
          },
        },
        claimedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { sentAt: 'asc' },
    });

    const now = Date.now();
    return tickets.map((t) => {
      const isClaimedActive =
        Boolean(t.claimedById) &&
        Boolean(t.claimedAt) &&
        now - new Date(t.claimedAt!).getTime() < 2 * 60 * 1000;

      const formatted = formatTicketWithItems(t);
      return {
        ...formatted,
        isClaimed: isClaimedActive,
        claimedByName: isClaimedActive ? (t.claimedBy?.name || t.claimedBy?.email || 'Otro cajero') : null,
      };
    });
  }

  /**
   * Consulta tickets del día del vendedor actual.
   */
  async findMine(businessId: string, sellerId: string) {
    await this.sweepExpirations(businessId);

    const todayStr = formatDateInTimezone(new Date(), 'America/Managua');
    const today = parseLocalDateToUtc(todayStr, '00:00:00.000', 'America/Managua');

    const tickets = await this.prisma.presaleTicket.findMany({
      where: {
        businessId,
        sellerId,
        businessDate: today,
      },
      include: {
        items: {
          include: {
            product: { select: { id: true, price: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const sentCount = tickets.length;
    const chargedTickets = tickets.filter((t) => t.status === 'CHARGED');
    const chargedCount = chargedTickets.length;
    const pendingTickets = tickets.filter((t) => t.status === 'PENDING');
    const pendingCount = pendingTickets.length;
    const cancelledCount = tickets.filter((t) => t.status === 'CANCELLED').length;
    const expiredCount = tickets.filter((t) => t.status === 'EXPIRED').length;
    const totalSentAmount = tickets.reduce(
      (sum, t) => sum + Number(t.total),
      0,
    );
    const totalChargedAmount = chargedTickets.reduce(
      (sum, t) => sum + Number(t.total),
      0,
    );

    return {
      summary: {
        sentCount,
        chargedCount,
        pendingCount,
        cancelledCount,
        expiredCount,
        totalSentAmount,
        totalChargedAmount,
      },
      tickets: tickets.map((t) => formatTicketWithItems(t)),
    };
  }

  /**
   * Consulta un ticket por ID.
   */
  async findById(businessId: string, id: string) {
    const ticket = await this.prisma.presaleTicket.findFirst({
      where: { id, businessId },
      include: {
        items: {
          include: {
            product: { select: { id: true, price: true, name: true } },
          },
        },
        events: { orderBy: { createdAt: 'asc' } },
        sale: { select: { id: true, invoiceNumber: true, total: true } },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket por cobrar no encontrado');

    // Si está pendiente pero expiró, ejecutar barrido
    if (ticket.status === 'PENDING' && ticket.expiresAt.getTime() <= Date.now()) {
      await this.sweepExpirations(businessId);
      return this.findById(businessId, id);
    }

    return formatTicketWithItems(ticket);
  }

  /**
   * Consulta un ticket por código de barras o displayNumber (ej. TK-P-0042-... o P-0042).
   */
  async findByCode(businessId: string, code: string) {
    const normalized = code.trim();
    const ticket = await this.prisma.presaleTicket.findFirst({
      where: {
        businessId,
        OR: [
          { scanCode: normalized },
          { displayNumber: normalized.toUpperCase() },
        ],
      },
      include: {
        items: {
          include: {
            product: { select: { id: true, price: true, name: true } },
          },
        },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket no encontrado');

    if (ticket.status === 'PENDING' && ticket.expiresAt.getTime() <= Date.now()) {
      await this.sweepExpirations(businessId);
      return this.findById(businessId, ticket.id);
    }

    return formatTicketWithItems(ticket);
  }

  /**
   * Bloqueo temporal de caja (2 minutos).
   */
  async claim(
    businessId: string,
    id: string,
    cashier: { sub: string; name?: string; email?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const [ticket]: any[] = await tx.$queryRaw`
        SELECT * FROM pos_presale_tickets
        WHERE id = ${id} AND "businessId" = ${businessId}
        FOR UPDATE;
      `;

      if (!ticket) throw new NotFoundException('Ticket no encontrado');

      if (ticket.status !== 'PENDING') {
        throw new ConflictException(
          `El ticket no se encuentra pendiente (estado actual: ${ticket.status})`,
        );
      }

      const now = Date.now();
      const claimedAtMs = ticket.claimedAt ? new Date(ticket.claimedAt).getTime() : 0;
      const isClaimedByOther =
        ticket.claimedById &&
        ticket.claimedById !== cashier.sub &&
        now - claimedAtMs < 2 * 60 * 1000;

      if (isClaimedByOther) {
        throw new ConflictException(
          `Lo está cobrando ${ticket.claimedByName || 'otro cajero'}`,
        );
      }

      const cashierName = cashier.name || cashier.email || 'Cajero';
      const updated = await tx.presaleTicket.update({
        where: { id },
        data: {
          claimedById: cashier.sub,
          claimedAt: new Date(),
          events: {
            create: {
              businessId,
              eventType: 'CLAIMED',
              userId: cashier.sub,
              userRole: 'CAJERO',
              details: { cashierName },
            },
          },
        },
        include: {
          items: {
            include: {
              product: { select: { id: true, price: true, name: true } },
            },
          },
        },
      });

      return formatTicketWithItems(updated);
    });
  }

  /**
   * Modifica líneas de preventa en caja (quitar, bajar cantidad, agregar).
   * Ajusta reservas y marca agregados con origin = 'CASHIER'.
   */
  async updateItems(
    businessId: string,
    id: string,
    cashier: { sub: string; name?: string; email?: string; role?: string },
    dto: UpdatePresaleItemsDto,
  ) {
    const actions = dto.actions || dto.items || [];
    if (actions.length === 0) {
      throw new BadRequestException('Se requiere al menos una acción sobre los items');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        wholesaleEnabled: true,
        taxRate: true,
        taxEnabled: true,
        taxIncluded: true,
        useListPrice: true,
      },
    });

    return this.prisma.$transaction(async (tx) => {
      const [ticket]: any[] = await tx.$queryRaw`
        SELECT * FROM pos_presale_tickets
        WHERE id = ${id} AND "businessId" = ${businessId}
        FOR UPDATE;
      `;

      if (!ticket) throw new NotFoundException('Ticket no encontrado');
      if (ticket.status !== 'PENDING') {
        throw new ConflictException('Solo se pueden editar tickets pendientes');
      }

      const cashierName = cashier.name || cashier.email || 'Cajero';

      for (const act of actions) {
        if (!act.reason) {
          throw new BadRequestException('El motivo de la modificación es obligatorio');
        }

        if (act.action === 'REMOVE') {
          const item = await tx.presaleTicketItem.findFirst({
            where: {
              ticketId: id,
              OR: [
                ...(act.ticketItemId ? [{ id: act.ticketItemId }] : []),
                ...(act.productId ? [{ productId: act.productId }] : []),
              ],
              removedAt: null,
            },
          });

          if (item) {
            // Liberar reserva
            if (item.productId && Number(item.reservedQty) > 0) {
              await tx.product.update({
                where: { id: item.productId },
                data: { reservedStock: { decrement: Number(item.reservedQty) } },
              });
            }

            await tx.presaleTicketItem.update({
              where: { id: item.id },
              data: {
                removedAt: new Date(),
                removedById: cashier.sub,
                removedReason: act.reason,
                reservedQty: 0,
              },
            });

            await tx.presaleTicketEvent.create({
              data: {
                ticketId: id,
                businessId,
                eventType: 'ITEM_REMOVED',
                userId: cashier.sub,
                userRole: cashier.role || 'CAJERO',
                details: {
                  itemId: item.id,
                  productName: item.productName,
                  reason: act.reason,
                },
              },
            });
          }
        } else if (act.action === 'MODIFY') {
          const item = await tx.presaleTicketItem.findFirst({
            where: {
              ticketId: id,
              OR: [
                ...(act.ticketItemId ? [{ id: act.ticketItemId }] : []),
                ...(act.productId ? [{ productId: act.productId }] : []),
              ],
              removedAt: null,
            },
          });

          if (!item) {
            throw new NotFoundException('Línea a modificar no encontrada');
          }

          const newQty = Number(act.quantity);
          const oldQty = Number(item.quantity);
          const oldReserved = Number(item.reservedQty);

          if (newQty <= 0) {
            // Equivalente a quitar
            if (item.productId && oldReserved > 0) {
              await tx.product.update({
                where: { id: item.productId },
                data: { reservedStock: { decrement: oldReserved } },
              });
            }

            await tx.presaleTicketItem.update({
              where: { id: item.id },
              data: {
                removedAt: new Date(),
                removedById: cashier.sub,
                removedReason: act.reason,
                reservedQty: 0,
              },
            });

            await tx.presaleTicketEvent.create({
              data: {
                ticketId: id,
                businessId,
                eventType: 'ITEM_REMOVED',
                userId: cashier.sub,
                userRole: cashier.role || 'CAJERO',
                details: {
                  itemId: item.id,
                  productName: item.productName,
                  reason: act.reason,
                },
              },
            });
          } else if (newQty < oldQty) {
            // Reducir cantidad: liberar diferencia
            const diff = oldQty - newQty;
            const newReserved = Math.max(0, oldReserved - diff);
            if (item.productId && diff > 0 && oldReserved > 0) {
              await tx.product.update({
                where: { id: item.productId },
                data: { reservedStock: { decrement: diff } },
              });
            }

            const newSubtotal = round3(newQty * Number(item.unitPrice));
            await tx.presaleTicketItem.update({
              where: { id: item.id },
              data: {
                quantity: newQty,
                reservedQty: newReserved,
                subtotal: newSubtotal,
              },
            });

            await tx.presaleTicketEvent.create({
              data: {
                ticketId: id,
                businessId,
                eventType: 'QTY_CHANGED',
                userId: cashier.sub,
                userRole: cashier.role || 'CAJERO',
                details: {
                  itemId: item.id,
                  productName: item.productName,
                  oldQty,
                  newQty,
                  reason: act.reason,
                },
              },
            });
          }
        } else if (act.action === 'ADD') {
          if (!act.productId) {
            throw new BadRequestException('El productId es obligatorio para agregar producto');
          }
          const qty = Number(act.quantity || 1);
          const product = await tx.product.findFirst({
            where: { id: act.productId, businessId },
          });
          if (!product) throw new NotFoundException('Producto no encontrado');

          // Reservar stock si aplica
          let reservedQty = 0;
          if (product.trackStock) {
            const available = Number(product.stock) - Number(product.reservedStock || 0);
            if (available < qty) {
              throw new ConflictException(
                `Stock insuficiente para "${product.name}". Disponible: ${available}, solicitado: ${qty}`,
              );
            }
            await tx.product.update({
              where: { id: product.id },
              data: { reservedStock: { increment: qty } },
            });
            reservedQty = qty;
          }

          const resolved = resolveLineUnitPrice(product, qty, business);
          const unitPrice =
            act.unitPrice !== undefined && act.unitPrice !== null
              ? Number(act.unitPrice)
              : resolved.unitPrice;
          const subtotal = round3(qty * unitPrice);

          const newItem = await tx.presaleTicketItem.create({
            data: {
              ticketId: id,
              productId: product.id,
              productName: product.name,
              barcode: product.barcode,
              quantity: qty,
              reservedQty,
              unitPrice,
              priceTier: resolved.priceTier,
              listPrice: product.listPrice != null ? Number(product.listPrice) : null,
              taxable: Boolean(product.taxable),
              taxRate: product.taxable ? Number(business?.taxRate || 15) : 0,
              subtotal,
              origin: 'CASHIER',
            },
          });

          await tx.presaleTicketEvent.create({
            data: {
              ticketId: id,
              businessId,
              eventType: 'ITEM_ADDED',
              userId: cashier.sub,
              userRole: cashier.role || 'CAJERO',
              details: {
                itemId: newItem.id,
                productName: product.name,
                qty,
                unitPrice,
                reason: act.reason,
              },
            },
          });
        }
      }

      // Recalcular totales del ticket con las líneas activas
      const activeItems = await tx.presaleTicketItem.findMany({
        where: { ticketId: id, removedAt: null },
      });

      const rawLines = activeItems.map((ai) => ({
        productId: ai.productId,
        productName: ai.productName,
        barcode: ai.barcode,
        unitPrice: Number(ai.unitPrice),
        quantity: Number(ai.quantity),
        discount: Number(ai.discount),
        listPrice: ai.listPrice != null ? Number(ai.listPrice) : null,
        taxable: Boolean(ai.taxable),
      }));

      const newTotals = calculateSaleTotals(rawLines, 0, business);

      const updatedTicket = await tx.presaleTicket.update({
        where: { id },
        data: {
          subtotal: newTotals.subtotal,
          discountAmount: newTotals.discountAmount,
          taxAmount: newTotals.taxAmount,
          total: newTotals.total,
          listPriceTotal: newTotals.listPriceTotal,
          version: { increment: 1 },
        },
        include: {
          items: {
            include: {
              product: { select: { id: true, price: true, name: true } },
            },
          },
        },
      });

      return formatTicketWithItems(updatedTicket);
    });
  }

  /**
   * Cobro atómico de un ticket por cobrar.
   * Ejecuta SalesService.create dentro de la misma transacción, libera reservas y marca CHARGED.
   */
  async charge(
    businessId: string,
    id: string,
    cashier: { sub: string; name?: string; email?: string; role?: string },
    clientInfo: { channel?: string; deviceId?: string },
    dto: ChargePresaleTicketDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. SELECT FOR UPDATE del ticket
      const [ticket]: any[] = await tx.$queryRaw`
        SELECT * FROM pos_presale_tickets
        WHERE id = ${id} AND "businessId" = ${businessId}
        FOR UPDATE;
      `;

      if (!ticket) throw new NotFoundException('Ticket por cobrar no encontrado');

      if (ticket.status === 'CHARGED') {
        const existingSale = ticket.saleId
          ? await tx.sale.findUnique({
              where: { id: ticket.saleId },
              select: { id: true, invoiceNumber: true, total: true },
            })
          : null;

        throw new ConflictException({
          statusCode: 409,
          code: 'TICKET_ALREADY_CHARGED',
          message: 'El ticket ya fue cobrado por otra caja',
          ticketId: id,
          saleId: ticket.saleId,
          sale: existingSale,
        });
      }

      if (ticket.status === 'CANCELLED') {
        throw new ConflictException('El ticket se encuentra anulado');
      }

      if (ticket.status === 'EXPIRED' || new Date(ticket.expiresAt).getTime() <= Date.now()) {
        throw new ConflictException('El ticket se encuentra vencido');
      }

      // 2. Obtener líneas activas
      const activeItems = await tx.presaleTicketItem.findMany({
        where: { ticketId: id, removedAt: null },
      });

      if (activeItems.length === 0) {
        throw new BadRequestException('El ticket no contiene productos activos para cobrar');
      }

      // 3. Construir CreateSaleDto para SalesService.create
      const saleDto: any = {
        cashRegisterId: dto.cashRegisterId,
        paymentMethod: dto.paymentMethod,
        amountPaid: dto.amountPaid,
        payments: dto.payments,
        discountAmount: dto.discountAmount || 0,
        creditPlan: dto.creditPlan,
        customerId: dto.customerId || ticket.customerId || null,
        customerName: dto.customerName || ticket.customerName || null,
        customerPhone: dto.customerPhone || ticket.customerPhone || null,
        customerRuc: dto.customerRuc || null,
        notes: dto.notes
          ? `${dto.notes} [Ticket ${ticket.displayNumber}]`
          : `[Ticket ${ticket.displayNumber}]`,
        reference: dto.reference || null,
        approvalToken: dto.approvalToken,
        sellerId: ticket.sellerId,
        sellerName: ticket.sellerName,
        presaleTicketId: ticket.id,
        items: activeItems.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          barcode: item.barcode,
          unitPrice: Number(item.unitPrice),
          quantity: Number(item.quantity),
          listPrice: item.listPrice != null ? Number(item.listPrice) : null,
          taxable: Boolean(item.taxable),
          origin: item.origin, // 'SELLER' o 'CASHIER'
        })),
      };

      // 4. Crear la venta atómicamente pasando externalTx
      const sale = await this.salesService.create(
        saleDto,
        businessId,
        cashier.sub,
        cashier.role,
        clientInfo,
        tx,
      );

      // 5. Liberar reservas de stock de este ticket
      for (const item of activeItems) {
        if (item.productId && Number(item.reservedQty) > 0) {
          await tx.product.update({
            where: { id: item.productId },
            data: { reservedStock: { decrement: Number(item.reservedQty) } },
          });
        }
      }

      const cashierName = cashier.name || cashier.email || 'Cajero';

      // 6. Marcar ticket CHARGED
      await tx.presaleTicket.update({
        where: { id },
        data: {
          status: 'CHARGED',
          chargedAt: new Date(),
          chargedById: cashier.sub,
          saleId: sale.id,
          events: {
            create: {
              businessId,
              eventType: 'CHARGED',
              userId: cashier.sub,
              userRole: cashier.role || 'CAJERO',
              details: {
                saleId: sale.id,
                invoiceNumber: sale.invoiceNumber,
                total: sale.total,
              },
            },
          },
        },
      });

      return sale;
    });
  }

  /**
   * Anulación de ticket (vendedor solo los suyos; cajero/encargado cualquiera).
   * Libera stock reservado.
   */
  async cancel(
    businessId: string,
    id: string,
    user: { sub: string; name?: string; email?: string; role?: string },
    reason: string,
  ) {
    if (!reason || reason.trim() === '') {
      throw new BadRequestException('El motivo de anulación es obligatorio');
    }

    return this.prisma.$transaction(async (tx) => {
      const [ticket]: any[] = await tx.$queryRaw`
        SELECT * FROM pos_presale_tickets
        WHERE id = ${id} AND "businessId" = ${businessId}
        FOR UPDATE;
      `;

      if (!ticket) throw new NotFoundException('Ticket por cobrar no encontrado');

      // Vendedor solo puede anular sus propios tickets
      if (user.role === UserRole.VENDEDOR && ticket.sellerId !== user.sub) {
        throw new ForbiddenException(
          'Los vendedores solo pueden anular sus propios tickets',
        );
      }

      if (ticket.status !== 'PENDING') {
        throw new ConflictException(
          `No se puede anular un ticket en estado "${ticket.status}"`,
        );
      }

      // Liberar stock reservado
      const items = await tx.presaleTicketItem.findMany({
        where: { ticketId: id, removedAt: null },
      });

      for (const item of items) {
        if (item.productId && Number(item.reservedQty) > 0) {
          await tx.product.update({
            where: { id: item.productId },
            data: { reservedStock: { decrement: Number(item.reservedQty) } },
          });
        }
      }

      const userName = user.name || user.email || 'Usuario';

      const updated = await tx.presaleTicket.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: user.sub,
          cancelReason: reason,
          events: {
            create: {
              businessId,
              eventType: 'CANCELLED',
              userId: user.sub,
              userRole: user.role || 'VENDEDOR',
              details: { reason, cancelledByName: userName },
            },
          },
        },
        include: {
          items: {
            include: {
              product: { select: { id: true, price: true, name: true } },
            },
          },
        },
      });

      return formatTicketWithItems(updated);
    });
  }

  /**
   * Barrido de vencimiento: marca EXPIRED y libera reservas de tickets pendientes vencidos.
   */
  async sweepExpirations(businessId?: string): Promise<number> {
    const now = new Date();
    const where: any = {
      status: 'PENDING',
      expiresAt: { lte: now },
    };
    if (businessId) where.businessId = businessId;

    const expiredTickets = await this.prisma.presaleTicket.findMany({
      where,
      select: { id: true, businessId: true },
    });

    let expiredCount = 0;

    for (const t of expiredTickets) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const [locked]: any[] = await tx.$queryRaw`
            SELECT * FROM pos_presale_tickets
            WHERE id = ${t.id} FOR UPDATE;
          `;
          if (!locked || locked.status !== 'PENDING') return;

          const items = await tx.presaleTicketItem.findMany({
            where: { ticketId: t.id, removedAt: null },
          });

          for (const item of items) {
            if (item.productId && Number(item.reservedQty) > 0) {
              await tx.product.update({
                where: { id: item.productId },
                data: { reservedStock: { decrement: Number(item.reservedQty) } },
              });
            }
          }

          await tx.presaleTicket.update({
            where: { id: t.id },
            data: {
              status: 'EXPIRED',
              events: {
                create: {
                  businessId: t.businessId,
                  eventType: 'EXPIRED',
                  details: { reason: 'Vencimiento automático por tiempo o fin de día' },
                },
              },
            },
          });
          expiredCount++;
        });
      } catch (err: any) {
        this.logger.warn(`[sweepExpirations] Error al expirar ticket ${t.id}: ${err.message}`);
      }
    }

    if (expiredCount > 0) {
      this.logger.log(`[sweepExpirations] Se expiraron ${expiredCount} tickets pendientes.`);
    }

    return expiredCount;
  }
}
