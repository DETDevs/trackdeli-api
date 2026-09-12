import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PosPaymentMethod, TableOrderStatus, TableShape } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { CreateSaleDto } from '../sales/dto/create-sale.dto';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { AddOrderItemsDto } from './dto/add-order-items.dto';
import { UpdateOrderItemDto } from './dto/update-order-item.dto';
import { CheckoutTableOrderDto } from './dto/checkout-table-order.dto';

@Injectable()
export class TablesService {
  private readonly logger = new Logger(TablesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesService: SalesService,
  ) {}

  async findAllTables(businessId: string) {
    return this.prisma.restaurantTable.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ gridY: 'asc' }, { gridX: 'asc' }, { number: 'asc' }],
    });
  }

  async createTable(businessId: string, dto: CreateTableDto) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, gridColumns: true, gridRows: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
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
        gridX: dto.gridX,
        gridY: dto.gridY,
        isActive: true,
      },
    });
    if (existingPosition) {
      throw new ConflictException(
        `La celda (${dto.gridX}, ${dto.gridY}) ya está ocupada por la mesa "${existingPosition.number}"`,
      );
    }

    const table = await this.prisma.restaurantTable.create({
      data: {
        businessId,
        number: dto.number.trim(),
        capacity: dto.capacity,
        shape: dto.shape || TableShape.SQUARE,
        gridX: dto.gridX,
        gridY: dto.gridY,
      },
    });

    this.logger.log(`[createTable] Mesa creada: id=${table.id} (${table.number}) en businessId=${businessId}`);
    return table;
  }

  async updateTable(businessId: string, tableId: string, dto: UpdateTableDto) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
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

    if (dto.gridX !== undefined || dto.gridY !== undefined) {
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

      const collision = await this.prisma.restaurantTable.findFirst({
        where: {
          businessId,
          gridX: newX,
          gridY: newY,
          isActive: true,
          id: { not: tableId },
        },
      });
      if (collision) {
        throw new ConflictException(
          `La celda (${newX}, ${newY}) ya está ocupada por la mesa "${collision.number}"`,
        );
      }
    }

    return this.prisma.restaurantTable.update({
      where: { id: tableId },
      data: {
        ...(dto.number !== undefined && { number: dto.number.trim() }),
        ...(dto.capacity !== undefined && { capacity: dto.capacity }),
        ...(dto.shape !== undefined && { shape: dto.shape }),
        ...(dto.gridX !== undefined && { gridX: dto.gridX }),
        ...(dto.gridY !== undefined && { gridY: dto.gridY }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async deleteTable(businessId: string, tableId: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
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

    this.logger.log(`[deleteTable] Mesa desactivada: id=${tableId} en businessId=${businessId}`);
    return { success: true, message: 'Mesa eliminada exitosamente' };
  }

  async getTablesStatus(businessId: string) {
    const tables = await this.prisma.restaurantTable.findMany({
      where: { businessId, isActive: true },
      include: {
        orders: {
          where: { status: TableOrderStatus.OPEN },
          include: {
            items: true,
          },
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
          itemsCount += item.quantity;
          total += item.quantity * item.unitPrice;
        }
      }

      return {
        id: t.id,
        number: t.number,
        capacity: t.capacity,
        shape: t.shape,
        gridX: t.gridX,
        gridY: t.gridY,
        status: isOccupied ? ('OCCUPIED' as const) : ('FREE' as const),
        currentOrder: currentOrder
          ? {
              id: currentOrder.id,
              status: currentOrder.status,
              createdAt: currentOrder.createdAt,
              notes: currentOrder.notes,
              itemsCount,
              total: Math.round(total * 100) / 100,
            }
          : null,
      };
    });
  }

  async openTableOrder(businessId: string, tableId: string) {
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
          select: { id: true, number: true, capacity: true, shape: true },
        },
      },
    });

    if (existingOrder) {
      return this.formatOrderResponse(existingOrder);
    }

    const newOrder = await this.prisma.tableOrder.create({
      data: {
        businessId,
        tableId,
        status: TableOrderStatus.OPEN,
      },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, imageUrl: true, price: true },
            },
          },
        },
        table: {
          select: { id: true, number: true, capacity: true, shape: true },
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
              select: { id: true, name: true, imageUrl: true, price: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        table: {
          select: { id: true, number: true, capacity: true, shape: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    return this.formatOrderResponse(order);
  }

  async addOrderItems(businessId: string, tableId: string, dto: AddOrderItemsDto) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
    });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    let order = await this.prisma.tableOrder.findFirst({
      where: { tableId, status: TableOrderStatus.OPEN },
    });

    if (!order) {
      order = await this.prisma.tableOrder.create({
        data: { businessId, tableId, status: TableOrderStatus.OPEN },
      });
    }

    for (const item of dto.items) {
      const product = await this.prisma.product.findFirst({
        where: { id: item.productId, businessId, isActive: true },
      });
      if (!product) {
        throw new NotFoundException(`Producto ${item.productId} no encontrado o inactivo`);
      }

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
          data: { quantity: existingItem.quantity + item.quantity },
        });
      } else {
        await this.prisma.tableOrderItem.create({
          data: {
            tableOrderId: order.id,
            productId: product.id,
            productName: product.name,
            unitPrice: product.price,
            quantity: item.quantity,
            notes: item.notes?.trim() || null,
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
      await this.prisma.tableOrderItem.update({
        where: { id: itemId },
        data: {
          quantity: dto.quantity,
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
      subtotal += item.quantity * item.unitPrice;
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
      items: order.items.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        unitPrice: i.unitPrice,
        quantity: i.quantity,
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

  private formatOrderResponse(order: any) {
    let subtotal = 0;
    let itemsCount = 0;

    const formattedItems = (order.items || []).map((item: any) => {
      const itemSubtotal = item.quantity * item.unitPrice;
      subtotal += itemSubtotal;
      itemsCount += item.quantity;
      return {
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        subtotal: Math.round(itemSubtotal * 100) / 100,
        notes: item.notes,
        product: item.product || null,
        createdAt: item.createdAt,
      };
    });

    return {
      id: order.id,
      businessId: order.businessId,
      tableId: order.tableId,
      status: order.status,
      notes: order.notes,
      createdAt: order.createdAt,
      closedAt: order.closedAt,
      saleId: order.saleId,
      table: order.table || null,
      itemsCount,
      subtotal: Math.round(subtotal * 100) / 100,
      items: formattedItems,
    };
  }
}

