import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PosPaymentMethod, TableOrderStatus, TableShape, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { SalesService } from '../sales/sales.service';
import { AuditService } from '../audit/audit.service';
import { CreateSaleDto } from '../sales/dto/create-sale.dto';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { AddOrderItemsDto } from './dto/add-order-items.dto';
import { UpdateOrderItemDto } from './dto/update-order-item.dto';
import { CheckoutTableOrderDto } from './dto/checkout-table-order.dto';
import { CancelTableOrderDto } from './dto/cancel-table-order.dto';
import { validateProductQuantity, round3 } from '../products/product-unit.util';

@Injectable()
export class TablesService {
  private readonly logger = new Logger(TablesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesService: SalesService,
    private readonly auditService: AuditService,
  ) {}

  async findAllTables(businessId: string, zoneId?: string) {
    const where: any = { businessId, isActive: true };
    if (zoneId) {
      if (zoneId === 'null' || zoneId === 'none' || zoneId === 'sin-zona') {
        where.zoneId = null;
      } else {
        where.zoneId = zoneId;
      }
    }

    const tables = await this.prisma.restaurantTable.findMany({
      where,
      include: {
        zone: {
          select: { id: true, name: true },
        },
      },
      orderBy: [{ gridY: 'asc' }, { gridX: 'asc' }, { number: 'asc' }],
    });

    return tables.map((t) => {
      const { zone, ...rest } = t;
      return {
        ...rest,
        zoneId: t.zoneId || null,
        zoneName: zone?.name || 'Sin zona',
      };
    });
  }

  async createTable(businessId: string, dto: CreateTableDto, user?: JwtPayload) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, gridColumns: true, gridRows: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    if (!dto.zoneId || !dto.zoneId.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'ZONE_REQUIRED',
      });
    }

    const zone = await this.prisma.salonZone.findFirst({
      where: { id: dto.zoneId.trim(), businessId, isActive: true },
    });
    if (!zone) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'ZONE_NOT_FOUND',
      });
    }

    if (
      dto.gridX < 0 ||
      dto.gridX >= business.gridColumns ||
      dto.gridY < 0 ||
      dto.gridY >= business.gridRows
    ) {
      throw new BadRequestException(
        `Coordenadas (${dto.gridX}, ${dto.gridY}) fuera de los límites de la grilla (${business.gridColumns}x${business.gridRows}).`,
      );
    }

    const existingNumber = await this.prisma.restaurantTable.findFirst({
      where: {
        businessId,
        number: { equals: dto.number.trim(), mode: 'insensitive' },
        isActive: true,
      },
    });
    if (existingNumber) {
      throw new ConflictException(`Ya existe una mesa con el identificador "${dto.number}"`);
    }

    const existingPosition = await this.prisma.restaurantTable.findFirst({
      where: {
        businessId,
        zoneId: zone.id,
        gridX: dto.gridX,
        gridY: dto.gridY,
        isActive: true,
      },
    });
    if (existingPosition) {
      throw new ConflictException(
        `La celda (${dto.gridX}, ${dto.gridY}) ya está ocupada por la mesa "${existingPosition.number}" en esta zona`,
      );
    }

    const table = await this.prisma.restaurantTable.create({
      data: {
        businessId,
        zoneId: zone.id,
        number: dto.number.trim(),
        capacity: dto.capacity,
        shape: dto.shape || TableShape.SQUARE,
        gridX: dto.gridX,
        gridY: dto.gridY,
      },
      include: {
        zone: {
          select: { id: true, name: true },
        },
      },
    });

    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action: 'TABLE_CREATED',
      entityType: 'RestaurantTable',
      entityId: table.id,
      after: {
        number: table.number,
        zoneId: table.zoneId,
        zoneName: table.zone?.name || 'Sin zona',
        capacity: table.capacity,
        shape: table.shape,
        gridX: table.gridX,
        gridY: table.gridY,
      },
    });

    this.logger.log(`[createTable] Mesa creada: id=${table.id} (${table.number}) en zona "${zone.name}" en businessId=${businessId}`);
    const { zone: zoneData, ...rest } = table;
    return {
      ...rest,
      zoneId: table.zoneId || null,
      zoneName: zoneData?.name || 'Sin zona',
    };
  }

  async updateTable(businessId: string, tableId: string, dto: UpdateTableDto, user?: JwtPayload) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
      include: {
        zone: {
          select: { id: true, name: true },
        },
      },
    });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, gridColumns: true, gridRows: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    let targetZoneId = table.zoneId;
    let targetZoneName = table.zone?.name || 'Sin zona';
    let isMovingZone = false;

    if (dto.zoneId !== undefined) {
      if (!dto.zoneId || !dto.zoneId.trim()) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: 'ZONE_REQUIRED',
        });
      }
      const targetZone = await this.prisma.salonZone.findFirst({
        where: { id: dto.zoneId.trim(), businessId, isActive: true },
      });
      if (!targetZone) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          message: 'ZONE_NOT_FOUND',
        });
      }
      if (targetZone.id !== table.zoneId) {
        isMovingZone = true;
      }
      targetZoneId = targetZone.id;
      targetZoneName = targetZone.name;
    }

    if (dto.number && dto.number.trim().toLowerCase() !== table.number.toLowerCase()) {
      const existingNumber = await this.prisma.restaurantTable.findFirst({
        where: {
          businessId,
          number: { equals: dto.number.trim(), mode: 'insensitive' },
          isActive: true,
          id: { not: tableId },
        },
      });
      if (existingNumber) {
        throw new ConflictException(`Ya existe una mesa con el identificador "${dto.number}"`);
      }
    }

    const newX = dto.gridX !== undefined ? dto.gridX : table.gridX;
    const newY = dto.gridY !== undefined ? dto.gridY : table.gridY;

    if (dto.gridX !== undefined || dto.gridY !== undefined || isMovingZone) {
      if (
        newX < 0 ||
        newX >= business.gridColumns ||
        newY < 0 ||
        newY >= business.gridRows
      ) {
        throw new BadRequestException(
          `Coordenadas (${newX}, ${newY}) fuera de los límites de la grilla (${business.gridColumns}x${business.gridRows}).`,
        );
      }

      const collisionWhere: any = {
        businessId,
        gridX: newX,
        gridY: newY,
        isActive: true,
        id: { not: tableId },
      };
      if (targetZoneId) {
        collisionWhere.zoneId = targetZoneId;
      } else {
        collisionWhere.zoneId = null;
      }

      const collision = await this.prisma.restaurantTable.findFirst({
        where: collisionWhere,
      });
      if (collision) {
        throw new ConflictException(
          `La celda (${newX}, ${newY}) ya está ocupada por la mesa "${collision.number}" en la zona destino`,
        );
      }
    }

    const updated = await this.prisma.restaurantTable.update({
      where: { id: tableId },
      data: {
        ...(dto.number !== undefined && { number: dto.number.trim() }),
        ...(dto.capacity !== undefined && { capacity: dto.capacity }),
        ...(dto.shape !== undefined && { shape: dto.shape }),
        ...(dto.gridX !== undefined && { gridX: dto.gridX }),
        ...(dto.gridY !== undefined && { gridY: dto.gridY }),
        ...(dto.zoneId !== undefined && { zoneId: targetZoneId }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: {
        zone: {
          select: { id: true, name: true },
        },
      },
    });

    const action = isMovingZone ? 'TABLE_MOVED_ZONE' : 'TABLE_UPDATED';
    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action,
      entityType: 'RestaurantTable',
      entityId: tableId,
      before: {
        number: table.number,
        zoneId: table.zoneId,
        zoneName: table.zone?.name || 'Sin zona',
        gridX: table.gridX,
        gridY: table.gridY,
        capacity: table.capacity,
        shape: table.shape,
      },
      after: {
        number: updated.number,
        zoneId: updated.zoneId,
        zoneName: updated.zone?.name || 'Sin zona',
        gridX: updated.gridX,
        gridY: updated.gridY,
        capacity: updated.capacity,
        shape: updated.shape,
      },
    });

    const { zone: updatedZone, ...rest } = updated;
    return {
      ...rest,
      zoneId: updated.zoneId || null,
      zoneName: updatedZone?.name || 'Sin zona',
    };
  }

  async deleteTable(businessId: string, tableId: string, user?: JwtPayload) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
      include: {
        zone: {
          select: { id: true, name: true },
        },
      },
    });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    const openOrder = await this.prisma.tableOrder.findFirst({
      where: { tableId, status: TableOrderStatus.OPEN },
    });
    if (openOrder) {
      throw new BadRequestException('No se puede eliminar una mesa que tiene un pedido abierto en curso');
    }

    await this.prisma.restaurantTable.update({
      where: { id: tableId },
      data: {
        isActive: false,
        number: `${table.number}_deleted_${Date.now()}`,
      },
    });

    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action: 'TABLE_DELETED',
      entityType: 'RestaurantTable',
      entityId: tableId,
      before: {
        number: table.number,
        zoneId: table.zoneId,
        zoneName: table.zone?.name || 'Sin zona',
      },
    });

    this.logger.log(`[deleteTable] Mesa desactivada: id=${tableId} en businessId=${businessId}`);
    return { success: true, message: 'Mesa eliminada exitosamente' };
  }

  async getTablesStatus(businessId: string, zoneId?: string) {
    const where: any = { businessId, isActive: true };
    if (zoneId) {
      if (zoneId === 'null' || zoneId === 'none' || zoneId === 'sin-zona') {
        where.zoneId = null;
      } else {
        where.zoneId = zoneId;
      }
    }

    const tables = await this.prisma.restaurantTable.findMany({
      where,
      include: {
        zone: {
          select: { id: true, name: true },
        },
        orders: {
          where: { status: TableOrderStatus.OPEN },
          include: {
            items: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ gridY: 'asc' }, { gridX: 'asc' }, { number: 'asc' }],
    });

    return tables.map((t) => {
      const currentOrder = t.orders.length > 0 ? t.orders[0] : null;
      const isOccupied = currentOrder !== null;

      let itemsCount = 0;
      let total = 0;

      if (currentOrder) {
        for (const item of currentOrder.items) {
          itemsCount += Number(item.quantity);
          total += Number(item.quantity) * Number(item.unitPrice);
        }
      }

      return {
        id: t.id,
        number: t.number,
        capacity: t.capacity,
        shape: t.shape,
        gridX: t.gridX,
        gridY: t.gridY,
        zoneId: t.zoneId || null,
        zoneName: t.zone?.name || 'Sin zona',
        status: isOccupied ? ('OCCUPIED' as const) : ('FREE' as const),
        currentOrder: currentOrder
          ? {
              id: currentOrder.id,
              status: currentOrder.status,
              openedAt: currentOrder.createdAt,
              createdAt: currentOrder.createdAt,
              notes: currentOrder.notes,
              itemsCount,
              total: Math.round(total * 100) / 100,
            }
          : null,
      };
    });
  }

  async openTableOrder(businessId: string, tableId: string, user?: JwtPayload) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
    });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    const existingOrder = await this.prisma.tableOrder.findFirst({
      where: { tableId, status: TableOrderStatus.OPEN },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, imageUrl: true, price: true },
            },
          },
        },
        table: {
          select: {
            id: true,
            number: true,
            capacity: true,
            shape: true,
            zoneId: true,
            zone: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (existingOrder) {
      return this.formatOrderResponse(existingOrder);
    }

    const isWaiter = user?.role === UserRole.WAITER;
    const openedByWaiterId = isWaiter ? user.sub : null;
    const openedByWaiterName = isWaiter ? (user.waiterName || null) : null;

    const newOrder = await this.prisma.tableOrder.create({
      data: {
        businessId,
        tableId,
        status: TableOrderStatus.OPEN,
        openedByWaiterId,
        openedByWaiterName,
      },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, imageUrl: true, price: true, unit: true, stock: true },
            },
          },
        },
        table: {
          select: {
            id: true,
            number: true,
            capacity: true,
            shape: true,
            zoneId: true,
            zone: { select: { id: true, name: true } },
          },
        },
      },
    });

    this.logger.log(`[openTableOrder] Orden ${newOrder.id} abierta para mesa ${table.number}`);
    return this.formatOrderResponse(newOrder);
  }

  async getActiveTableOrder(businessId: string, tableId: string) {
    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, imageUrl: true, price: true, unit: true, stock: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        table: {
          select: {
            id: true,
            number: true,
            capacity: true,
            shape: true,
            zoneId: true,
            zone: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    return this.formatOrderResponse(order);
  }

  async addOrderItems(businessId: string, tableId: string, dto: AddOrderItemsDto, user?: JwtPayload) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
    });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    const isWaiter = user?.role === UserRole.WAITER;
    const openedByWaiterId = isWaiter ? user.sub : null;
    const openedByWaiterName = isWaiter ? (user.waiterName || null) : null;
    const waiterId = isWaiter ? user.sub : null;
    const waiterName = isWaiter ? (user.waiterName || null) : null;

    let order = await this.prisma.tableOrder.findFirst({
      where: { tableId, status: TableOrderStatus.OPEN },
    });

    if (!order) {
      order = await this.prisma.tableOrder.create({
        data: {
          businessId,
          tableId,
          status: TableOrderStatus.OPEN,
          openedByWaiterId,
          openedByWaiterName,
        },
      });
    }

    for (const item of dto.items) {
      const product = await this.prisma.product.findFirst({
        where: { id: item.productId, businessId, isActive: true },
      });
      if (!product) {
        throw new NotFoundException(`Producto ${item.productId} no encontrado o inactivo`);
      }

      const itemQty = validateProductQuantity(product.unit, item.quantity, product.name);

      const existingItem = await this.prisma.tableOrderItem.findFirst({
        where: {
          tableOrderId: order.id,
          productId: product.id,
          notes: item.notes ? item.notes.trim() : null,
        },
      });

      if (existingItem) {
        await this.prisma.tableOrderItem.update({
          where: { id: existingItem.id },
          data: { quantity: round3(Number(existingItem.quantity) + itemQty) },
        });
      } else {
        await this.prisma.tableOrderItem.create({
          data: {
            tableOrderId: order.id,
            productId: product.id,
            productName: product.name,
            unitPrice: product.price,
            quantity: itemQty,
            notes: item.notes?.trim() || null,
            waiterId,
            waiterName,
          },
        });
      }
    }

    return this.getActiveTableOrder(businessId, tableId);
  }

  async updateOrderItem(
    businessId: string,
    tableId: string,
    itemId: string,
    dto: UpdateOrderItemDto,
  ) {
    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    const item = await this.prisma.tableOrderItem.findFirst({
      where: { id: itemId, tableOrderId: order.id },
    });
    if (!item) {
      throw new NotFoundException('Ítem de pedido no encontrado');
    }

    if (dto.quantity <= 0) {
      await this.prisma.tableOrderItem.delete({ where: { id: itemId } });
    } else {
      const product = await this.prisma.product.findUnique({ where: { id: item.productId } });
      const validQty = validateProductQuantity(product?.unit, dto.quantity, product?.name || item.productName);
      await this.prisma.tableOrderItem.update({
        where: { id: itemId },
        data: {
          quantity: validQty,
          ...(dto.notes !== undefined && { notes: dto.notes.trim() || null }),
        },
      });
    }

    return this.getActiveTableOrder(businessId, tableId);
  }

  async deleteOrderItem(businessId: string, tableId: string, itemId: string) {
    return this.updateOrderItem(businessId, tableId, itemId, { quantity: 0 });
  }

  async checkoutTableOrder(
    businessId: string,
    cashierId: string,
    tableId: string,
    dto: CheckoutTableOrderDto,
  ) {
    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        table: true,
      },
    });

    if (!order) {
      throw new BadRequestException('No hay un pedido abierto para cobrar en esta mesa');
    }

    if (order.items.length === 0) {
      throw new BadRequestException('El pedido de la mesa no contiene productos para facturar');
    }

    let subtotal = 0;
    for (const item of order.items) {
      subtotal += Number(item.quantity) * Number(item.unitPrice);
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { taxRate: true },
    });
    const taxRate = business?.taxRate || 0;
    const discountAmount = dto.discountAmount || 0;
    const taxable = Math.max(0, subtotal - discountAmount);
    const taxAmount = taxable * (taxRate / 100);
    const total = taxable + taxAmount;

    const amountPaid = dto.amountPaid !== undefined ? dto.amountPaid : Math.round(total * 100) / 100;

    const saleDto: CreateSaleDto = {
      paymentMethod: dto.paymentMethod || PosPaymentMethod.EFECTIVO,
      amountPaid,
      discountAmount,
      customerName: dto.customerName,
      customerPhone: dto.customerPhone,
      customerRuc: dto.customerRuc,
      cashRegisterId: dto.cashRegisterId,
      notes: dto.notes ? `${dto.notes} (Mesa ${order.table.number})` : `Mesa ${order.table.number}`,
      reference: dto.reference || dto.paymentReference,
      payments: dto.payments,
      items: order.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        unitPrice: i.unitPrice,
        quantity: round3(Number(i.quantity)),
        discount: 0,
      })),
    };

    const sale = await this.salesService.create(saleDto, businessId, cashierId);

    const closedOrder = await this.prisma.tableOrder.update({
      where: { id: order.id },
      data: {
        status: TableOrderStatus.CLOSED,
        closedAt: new Date(),
        saleId: sale.id,
      },
    });

    this.logger.log(
      `[checkoutTableOrder] Mesa ${order.table.number} facturada con éxito: saleId=${sale.id} invoice=${sale.invoiceNumber} orderId=${order.id}`,
    );

    return {
      sale,
      tableOrder: {
        id: closedOrder.id,
        tableId: closedOrder.tableId,
        status: closedOrder.status,
        closedAt: closedOrder.closedAt,
        saleId: closedOrder.saleId,
      },
    };
  }

  async cancelTableOrder(
    businessId: string,
    user: JwtPayload,
    tableId: string,
    dto?: CancelTableOrderDto,
  ) {
    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        table: true,
      },
    });

    if (!order) {
      throw new BadRequestException('No hay un pedido abierto para cancelar en esta mesa');
    }

    let cancelledByUserName: string | null = null;
    if (user?.sub) {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { name: true },
      });
      cancelledByUserName = dbUser?.name || user.email || null;
    }

    const cancelledOrder = await this.prisma.tableOrder.update({
      where: { id: order.id },
      data: {
        status: TableOrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledByUserId: user?.sub || null,
        cancelledByUserName,
        cancellationReason: dto?.reason?.trim() || null,
      },
    });

    this.logger.log(
      `[cancelTableOrder] Mesa ${order.table?.number || tableId} orden cancelada: orderId=${order.id} por user=${cancelledByUserName || user?.sub} motivo=${dto?.reason || 'sin motivo'}`,
    );

    return {
      success: true,
      message: 'Mesa liberada y pedido cancelado exitosamente',
      tableOrder: {
        id: cancelledOrder.id,
        tableId: cancelledOrder.tableId,
        status: cancelledOrder.status,
        cancelledAt: cancelledOrder.cancelledAt,
        cancelledByUserId: cancelledOrder.cancelledByUserId,
        cancelledByUserName: cancelledOrder.cancelledByUserName,
        reason: cancelledOrder.cancellationReason,
        cancellationReason: cancelledOrder.cancellationReason,
      },
    };
  }

  private formatOrderResponse(order: any) {
    let subtotal = 0;
    let itemsCount = 0;

    const formattedItems = (order.items || []).map((item: any) => {
      const itemQty = Number(item.quantity);
      const itemSubtotal = itemQty * item.unitPrice;
      subtotal += itemSubtotal;
      itemsCount += itemQty;
      return {
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice,
        quantity: itemQty,
        subtotal: Math.round(itemSubtotal * 100) / 100,
        notes: item.notes,
        waiterId: item.waiterId || null,
        waiterName: item.waiterName || null,
        product: item.product
          ? {
              ...item.product,
              stock: item.product.stock != null ? Number(item.product.stock) : undefined,
              unit: item.product.unit || 'UND',
            }
          : null,
        createdAt: item.createdAt,
      };
    });

    return {
      id: order.id,
      businessId: order.businessId,
      tableId: order.tableId,
      status: order.status,
      notes: order.notes,
      openedByWaiterId: order.openedByWaiterId || null,
      openedByWaiterName: order.openedByWaiterName || null,
      cancelledAt: order.cancelledAt || null,
      cancelledByUserId: order.cancelledByUserId || null,
      cancelledByUserName: order.cancelledByUserName || null,
      cancellationReason: order.cancellationReason || null,
      createdAt: order.createdAt,
      closedAt: order.closedAt,
      saleId: order.saleId,
      table: order.table
        ? {
            id: order.table.id,
            number: order.table.number,
            capacity: order.table.capacity,
            shape: order.table.shape,
            zoneId: order.table.zoneId || null,
            zoneName: order.table.zone?.name || 'Sin zona',
          }
        : null,
      itemsCount,
      subtotal: Math.round(subtotal * 100) / 100,
      items: formattedItems,
    };
  }
}

