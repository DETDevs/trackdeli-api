import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
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
import { ReceiveVehicleDto } from './dto/receive-vehicle.dto';
import { UpdateOrderAssignmentDto } from './dto/update-order-assignment.dto';
import { SendToKitchenDto } from './dto/send-to-kitchen.dto';
import { VoidOrderItemDto } from './dto/void-order-item.dto';
import { StartSplitDto } from './dto/start-split.dto';
import { MoveSplitItemDto } from './dto/move-split-item.dto';
import { AddSubAccountDto } from './dto/add-sub-account.dto';
import { MergeSubAccountsDto } from './dto/merge-sub-accounts.dto';
import { UndoSplitDto } from './dto/undo-split.dto';
import { SetOrderDiscountDto } from './dto/set-order-discount.dto';
import { getSalonLabels } from '../salon/salon-profile.util';
import { validateProductQuantity, round3 } from '../products/product-unit.util';
import { WorkshopService } from '../workshop/workshop.service';

@Injectable()
export class TablesService {
  private readonly logger = new Logger(TablesService.name);
  private pinFailedAttempts = new Map<string, { count: number; resetAt: number }>();

  private checkPinRateLimit(key: string) {
    const now = Date.now();
    const record = this.pinFailedAttempts.get(key);
    if (record && record.resetAt > now) {
      if (record.count >= 5) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: 'Demasiados intentos fallidos. Intente de nuevo en 5 minutos.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  private recordPinFailure(key: string) {
    const now = Date.now();
    const record = this.pinFailedAttempts.get(key);
    if (!record || record.resetAt <= now) {
      this.pinFailedAttempts.set(key, { count: 1, resetAt: now + 5 * 60 * 1000 });
    } else {
      record.count += 1;
    }
  }

  private resetPinLimit(key: string) {
    this.pinFailedAttempts.delete(key);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly salesService: SalesService,
    private readonly auditService: AuditService,
    private readonly workshopService: WorkshopService,
  ) {}

  async findAllTables(businessId: string, zoneId?: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true },
    });
    const isTaller = business?.salonProfile === 'TALLER';

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
      orderBy: isTaller
        ? [{ createdAt: 'asc' }]
        : [{ gridY: 'asc' }, { gridX: 'asc' }, { number: 'asc' }],
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
      select: { id: true, gridColumns: true, gridRows: true, salonProfile: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }
    const isTaller = business.salonProfile === 'TALLER';

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

    const hasCoords =
      dto.gridX !== undefined && dto.gridX !== null && dto.gridY !== undefined && dto.gridY !== null;

    if (!isTaller) {
      if (!hasCoords) {
        throw new BadRequestException('Las coordenadas (gridX, gridY) son requeridas para este perfil');
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
    } else {
      // In TALLER: validate grid bounds & collision only if coordinates are provided
      if (hasCoords) {
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
      }
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

    const table = await this.prisma.restaurantTable.create({
      data: {
        businessId,
        zoneId: zone.id,
        number: dto.number.trim(),
        capacity: dto.capacity,
        shape: dto.shape || TableShape.SQUARE,
        gridX: dto.gridX !== undefined ? dto.gridX : null,
        gridY: dto.gridY !== undefined ? dto.gridY : null,
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
      select: { id: true, gridColumns: true, gridRows: true, salonProfile: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }
    const isTaller = business.salonProfile === 'TALLER';

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
    const hasCoordinates = newX !== null && newX !== undefined && newY !== null && newY !== undefined;

    if (!isTaller) {
      if (dto.gridX !== undefined || dto.gridY !== undefined || isMovingZone) {
        if (!hasCoordinates) {
          throw new BadRequestException('Las coordenadas (gridX, gridY) son requeridas para este perfil');
        }
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
    } else {
      if (hasCoordinates && (dto.gridX !== undefined || dto.gridY !== undefined)) {
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
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true },
    });
    const isTaller = business?.salonProfile === 'TALLER';

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
            assignedWaiter: {
              select: { id: true, name: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: isTaller
        ? [{ createdAt: 'asc' }]
        : [{ gridY: 'asc' }, { gridX: 'asc' }, { number: 'asc' }],
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

      const assignedWaiter = currentOrder?.assignedWaiter
        ? { id: currentOrder.assignedWaiter.id, name: currentOrder.assignedWaiter.name }
        : null;

      return {
        id: t.id,
        number: t.number,
        capacity: t.capacity,
        shape: t.shape,
        gridX: t.gridX,
        gridY: t.gridY,
        zoneId: t.zoneId || null,
        zoneName: t.zone?.name || 'Sin zona',
        customerName: currentOrder?.customerName || null,
        customerPhone: currentOrder?.customerPhone || null,
        vehicleInfo: currentOrder?.vehicleInfo || null,
        assignedWaiterId: currentOrder?.assignedWaiterId || null,
        assignedWaiter,
        status: isOccupied ? ('OCCUPIED' as const) : ('FREE' as const),
        currentOrder: currentOrder
          ? {
              id: currentOrder.id,
              status: currentOrder.status,
              openedAt: currentOrder.createdAt,
              createdAt: currentOrder.createdAt,
              notes: currentOrder.notes,
              customerName: currentOrder.customerName || null,
              customerPhone: currentOrder.customerPhone || null,
              vehicleInfo: currentOrder.vehicleInfo || null,
              assignedWaiterId: currentOrder.assignedWaiterId || null,
              assignedWaiter,
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
        assignedWaiter: {
          select: { id: true, name: true },
        },
        subAccounts: {
          orderBy: { createdAt: 'asc' },
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
        assignedWaiter: {
          select: { id: true, name: true },
        },
      },
    });

    this.logger.log(`[openTableOrder] Orden ${newOrder.id} abierta para mesa ${table.number}`);
    return this.formatOrderResponse(newOrder);
  }

  async getActiveTableOrder(businessId: string, tableId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { taxRate: true },
    });

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, imageUrl: true, price: true, unit: true, stock: true, sendToKitchen: true },
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
        assignedWaiter: {
          select: { id: true, name: true },
        },
        subAccounts: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    return this.formatOrderResponse(order, business?.taxRate || 0);
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

    let defaultSubAccountId: string | null = null;
    if (order.splitMode === 'ITEMS') {
      const firstOpen = await this.prisma.orderSubAccount.findFirst({
        where: { tableOrderId: order.id, status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
      });
      defaultSubAccountId = firstOpen ? firstOpen.id : null;
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
          kitchenRoundId: null,
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
            subAccountId: defaultSubAccountId,
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

    if (dto.quantity !== undefined && dto.quantity < Number(item.quantity)) {
      if (item.kitchenRoundId) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'AUTHORIZATION_REQUIRED',
        });
      }
    }

    if (dto.quantity <= 0) {
      if (item.kitchenRoundId) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'AUTHORIZATION_REQUIRED',
        });
      }
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

    if (item.kitchenRoundId) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'AUTHORIZATION_REQUIRED',
      });
    }

    await this.prisma.tableOrderItem.delete({ where: { id: itemId } });
    return this.getActiveTableOrder(businessId, tableId);
  }

  async checkoutTableOrder(
    businessId: string,
    cashierId: string,
    tableId: string,
    dto: CheckoutTableOrderDto,
    userRole?: string,
    clientInfo?: { channel?: string; deviceId?: string },
  ) {
    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        subAccounts: {
          orderBy: { createdAt: 'asc' },
        },
        table: {
          include: {
            zone: { select: { id: true, name: true } },
          },
        },
        assignedWaiter: { select: { id: true, name: true } },
      },
    });

    if (!order) {
      throw new BadRequestException('No hay un pedido abierto para cobrar en esta mesa');
    }

    if (order.items.length === 0) {
      throw new BadRequestException('El pedido de la mesa no contiene productos para facturar');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { taxRate: true, taxIncluded: true, taxEnabled: true, salonProfile: true },
    });
    const labels = getSalonLabels(business?.salonProfile);
    const taxRate = business?.taxRate || 0;

    const isSplit = Boolean(order.splitMode) || (order.subAccounts && order.subAccounts.length > 0);

    // If order is split, subAccountId is required
    if (isSplit && !dto.subAccountId) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'SUB_ACCOUNT_REQUIRED',
        message: 'La orden está dividida, debe especificar subAccountId para cobrar',
      });
    }

    if (dto.subAccountId) {
      const subAccount = order.subAccounts.find((sa) => sa.id === dto.subAccountId);
      if (!subAccount) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          code: 'SUB_ACCOUNT_NOT_FOUND',
          message: 'Subcuenta no encontrada en la orden',
        });
      }

      if (subAccount.status === 'PAID') {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'SUB_ACCOUNT_ALREADY_PAID',
          message: 'Esta subcuenta ya fue pagada',
        });
      }

      let saleDto: CreateSaleDto;

      if (order.splitMode === 'ITEMS') {
        const saItems = order.items.filter((i) => i.subAccountId === subAccount.id);
        if (saItems.length === 0) {
          throw new BadRequestException('La subcuenta no contiene productos para facturar');
        }

        let totalOrderSubtotal = 0;
        for (const item of order.items) {
          totalOrderSubtotal += Number(item.quantity) * Number(item.unitPrice);
        }
        totalOrderSubtotal = Math.round(totalOrderSubtotal * 100) / 100;

        const discountPercent = Number(order.discountPercent || 0);
        const discountAmountTotal = Number(order.discountAmount || 0);
        let totalOrderDiscount = 0;
        if (discountPercent > 0) {
          totalOrderDiscount = Math.round(totalOrderSubtotal * (discountPercent / 100) * 100) / 100;
        } else if (discountAmountTotal > 0) {
          totalOrderDiscount = Math.min(totalOrderSubtotal, Math.round(discountAmountTotal * 100) / 100);
        }

        const sortedSubAccounts = [...order.subAccounts].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
        const subAccountIdx = sortedSubAccounts.findIndex((sa) => sa.id === subAccount.id);
        const isLastSubAccount = subAccountIdx === sortedSubAccounts.length - 1;

        let saSubtotal = 0;
        for (const item of saItems) {
          saSubtotal += Number(item.quantity) * Number(item.unitPrice);
        }
        saSubtotal = Math.round(saSubtotal * 100) / 100;

        let saDiscount = 0;
        if (totalOrderSubtotal > 0 && totalOrderDiscount > 0) {
          let accumulatedDiscount = 0;
          for (let j = 0; j < sortedSubAccounts.length - 1; j++) {
            const saJItems = order.items.filter((i) => i.subAccountId === sortedSubAccounts[j].id);
            let subJ = 0;
            for (const it of saJItems) subJ += Number(it.quantity) * Number(it.unitPrice);
            subJ = Math.round(subJ * 100) / 100;
            const discJ = Math.round(totalOrderDiscount * (subJ / totalOrderSubtotal) * 100) / 100;
            if (j === subAccountIdx) {
              saDiscount = discJ;
            }
            accumulatedDiscount += discJ;
          }
          if (isLastSubAccount) {
            saDiscount = Math.round((totalOrderDiscount - accumulatedDiscount) * 100) / 100;
          }
        }

        const taxable = Math.max(0, saSubtotal - saDiscount);
        const taxAmount = Math.round(taxable * (taxRate / 100) * 100) / 100;
        const total = Math.round((taxable + taxAmount) * 100) / 100;

        const amountPaid = dto.amountPaid !== undefined ? dto.amountPaid : total;

        saleDto = {
          paymentMethod: dto.paymentMethod || PosPaymentMethod.EFECTIVO,
          amountPaid,
          discountAmount: saDiscount,
          customerId: dto.customerId || order.customerId || undefined,
          customerName: dto.customerName || order.customerName || undefined,
          customerPhone: dto.customerPhone || order.customerPhone || undefined,
          customerRuc: dto.customerRuc,
          tableNumber: order.table?.number || undefined,
          zoneName: order.table?.zone?.name || undefined,
          waiterName: order.assignedWaiter?.name || order.openedByWaiterName || undefined,
          vehicleInfo: order.vehicleInfo || undefined,
          workshopVehicleId: order.workshopVehicleId || undefined,
          cashRegisterId: dto.cashRegisterId,
          notes: dto.notes
            ? `${dto.notes} (${labels.table} ${order.table.number} - ${subAccount.label})`
            : `${labels.table} ${order.table.number} (${subAccount.label})`,
          reference: dto.reference || dto.paymentReference,
          payments: dto.payments,
          items: saItems.map((i) => ({
            productId: i.productId,
            productName: i.productName,
            unitPrice: i.unitPrice,
            quantity: round3(Number(i.quantity)),
            discount: 0,
          })),
        };
      } else {
        // EQUAL mode
        const fixedAmount = Number(subAccount.fixedAmount || 0);
        let unitPrice = fixedAmount;
        if (business?.taxEnabled && !business.taxIncluded && taxRate > 0) {
          unitPrice = Math.round((fixedAmount / (1 + (taxRate / 100))) * 100) / 100;
          const calcTax = Math.round(unitPrice * (taxRate / 100) * 100) / 100;
          const calcTot = Math.round((unitPrice + calcTax) * 100) / 100;
          const diff = Math.round((fixedAmount - calcTot) * 100) / 100;
          if (diff !== 0) {
            unitPrice = Math.round((unitPrice + diff) * 100) / 100;
          }
        }

        const amountPaid = dto.amountPaid !== undefined ? dto.amountPaid : fixedAmount;

        saleDto = {
          paymentMethod: dto.paymentMethod || PosPaymentMethod.EFECTIVO,
          amountPaid,
          discountAmount: 0,
          customerId: dto.customerId || order.customerId || undefined,
          customerName: dto.customerName || order.customerName || undefined,
          customerPhone: dto.customerPhone || order.customerPhone || undefined,
          customerRuc: dto.customerRuc,
          tableNumber: order.table?.number || undefined,
          zoneName: order.table?.zone?.name || undefined,
          waiterName: order.assignedWaiter?.name || order.openedByWaiterName || undefined,
          vehicleInfo: order.vehicleInfo || undefined,
          workshopVehicleId: order.workshopVehicleId || undefined,
          cashRegisterId: dto.cashRegisterId,
          notes: dto.notes
            ? `${dto.notes} (${labels.table} ${order.table.number} - ${subAccount.label})`
            : `${labels.table} ${order.table.number} (${subAccount.label})`,
          reference: dto.reference || dto.paymentReference,
          payments: dto.payments,
          items: [
            {
              productId: undefined,
              productName: `Consumo ${labels.table} ${order.table.number} (${subAccount.label})`,
              unitPrice,
              quantity: 1,
              discount: 0,
            },
          ],
        };
      }

      const sale = await this.salesService.create(saleDto, businessId, cashierId, userRole, clientInfo);

      await this.prisma.orderSubAccount.update({
        where: { id: subAccount.id },
        data: {
          status: 'PAID',
          saleId: sale.id,
        },
      });

      const remainingOpen = await this.prisma.orderSubAccount.count({
        where: {
          tableOrderId: order.id,
          status: 'OPEN',
        },
      });

      if (remainingOpen === 0) {
        const closedOrder = await this.prisma.tableOrder.update({
          where: { id: order.id },
          data: {
            status: TableOrderStatus.CLOSED,
            closedAt: new Date(),
            saleId: sale.id,
          },
        });

        if (business?.salonProfile === 'TALLER') {
          await this.prisma.restaurantTable.update({
            where: { id: order.tableId },
            data: { isActive: false },
          });
        }

        this.logger.log(
          `[checkoutTableOrder] Mesa ${order.table.number} - todas las subcuentas pagadas. Orden cerrada con éxito: saleId=${sale.id} orderId=${order.id}`,
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
          allAccountsPaid: true,
        };
      } else {
        this.logger.log(
          `[checkoutTableOrder] Mesa ${order.table.number} - subcuenta "${subAccount.label}" pagada (quedan ${remainingOpen} abiertas). Venta: ${sale.id}`,
        );

        return {
          sale,
          tableOrder: {
            id: order.id,
            tableId: order.tableId,
            status: order.status,
            closedAt: null,
            saleId: null,
          },
          remainingOpenAccounts: remainingOpen,
          allAccountsPaid: false,
        };
      }
    }

    // Normal checkout (unsplit order)
    let subtotal = 0;
    for (const item of order.items) {
      subtotal += Number(item.quantity) * Number(item.unitPrice);
    }

    const discountAmount = dto.discountAmount || 0;
    const taxable = Math.max(0, subtotal - discountAmount);
    const taxAmount = taxable * (taxRate / 100);
    const total = taxable + taxAmount;

    const amountPaid = dto.amountPaid !== undefined ? dto.amountPaid : Math.round(total * 100) / 100;

    const saleDto: CreateSaleDto = {
      paymentMethod: dto.paymentMethod || PosPaymentMethod.EFECTIVO,
      amountPaid,
      discountAmount,
      customerId: dto.customerId || order.customerId || undefined,
      customerName: dto.customerName || order.customerName || undefined,
      customerPhone: dto.customerPhone || order.customerPhone || undefined,
      customerRuc: dto.customerRuc,
      tableNumber: order.table?.number || undefined,
      zoneName: order.table?.zone?.name || undefined,
      waiterName: order.assignedWaiter?.name || order.openedByWaiterName || undefined,
      vehicleInfo: order.vehicleInfo || undefined,
      workshopVehicleId: order.workshopVehicleId || undefined,
      cashRegisterId: dto.cashRegisterId,
      notes: dto.notes
        ? `${dto.notes} (${labels.table} ${order.table.number})`
        : `${labels.table} ${order.table.number}`,
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

    const sale = await this.salesService.create(saleDto, businessId, cashierId, userRole, clientInfo);

    const closedOrder = await this.prisma.tableOrder.update({
      where: { id: order.id },
      data: {
        status: TableOrderStatus.CLOSED,
        closedAt: new Date(),
        saleId: sale.id,
      },
    });

    if (business?.salonProfile === 'TALLER') {
      await this.prisma.restaurantTable.update({
        where: { id: order.tableId },
        data: { isActive: false },
      });
      this.logger.log(
        `[checkoutTableOrder] Vehículo desactivado (isActive=false): tableId=${order.tableId} (${order.table.number})`,
      );
    }

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
      allAccountsPaid: true,
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
        subAccounts: true,
      },
    });

    if (!order) {
      throw new BadRequestException('No hay un pedido abierto para cancelar en esta mesa');
    }

    const hasPaidAccounts = order.subAccounts.some((sa) => sa.status === 'PAID');
    if (hasPaidAccounts) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_HAS_PAID_ACCOUNTS',
        message: 'No se puede cancelar una orden con subcuentas pagadas',
      });
    }

    await this.prisma.tableOrderItem.updateMany({
      where: { tableOrderId: order.id },
      data: { subAccountId: null },
    });
    await this.prisma.orderSubAccount.deleteMany({
      where: { tableOrderId: order.id },
    });

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

  async receiveVehicle(businessId: string, dto: ReceiveVehicleDto, user?: JwtPayload) {
    if (!dto.zoneId || !dto.zoneId.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'ZONE_REQUIRED',
      });
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, salonProfile: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }
    if (business.salonProfile !== 'TALLER') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'SALON_PROFILE_MISMATCH',
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

    const plateNumber = dto.number.trim();

    let table = await this.prisma.restaurantTable.findFirst({
      where: {
        businessId,
        number: { equals: plateNumber, mode: 'insensitive' },
      },
      include: {
        zone: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (table) {
      const openOrder = await this.prisma.tableOrder.findFirst({
        where: { tableId: table.id, status: TableOrderStatus.OPEN },
      });
      if (openOrder) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'VEHICLE_ALREADY_OPEN',
        });
      }

      table = await this.prisma.restaurantTable.update({
        where: { id: table.id },
        data: {
          isActive: true,
          zoneId: zone.id,
        },
        include: {
          zone: { select: { id: true, name: true } },
        },
      });
    } else {
      table = await this.prisma.restaurantTable.create({
        data: {
          businessId,
          zoneId: zone.id,
          number: plateNumber,
          capacity: 1,
          shape: TableShape.SQUARE,
          gridX: null,
          gridY: null,
          isActive: true,
        },
        include: {
          zone: { select: { id: true, name: true } },
        },
      });
    }

    const customerName = dto.customerName?.trim();
    if (!customerName || customerName.length < 2 || customerName.length > 120) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'El nombre del cliente debe tener entre 2 y 120 caracteres',
      });
    }

    const assignedWaiter = dto.technicianId !== undefined
      ? await this.resolveTechnician(businessId, dto.technicianId)
      : null;

    const isWaiter = user?.role === UserRole.WAITER;
    const openedByWaiterId = isWaiter ? user.sub : null;
    const openedByWaiterName = isWaiter ? (user.waiterName || null) : null;

    // Ficha del vehículo y cliente (Taller)
    let vehicleData: { vehicleId: string; customerId: string | null } | null = null;
    try {
      vehicleData = await this.workshopService.ensureVehicleOnReceive(businessId, {
        number: plateNumber,
        customerName,
        customerPhone: dto.customerPhone,
        customerId: dto.customerId,
        vehicleInfo: dto.vehicleInfo,
        mileage: dto.mileage,
      });
    } catch (vErr: any) {
      this.logger.error(`[receiveVehicle] Error no bloqueante al gestionar ficha de taller: ${vErr.message}`);
    }

    const newOrder = await this.prisma.tableOrder.create({
      data: {
        businessId,
        tableId: table.id,
        status: TableOrderStatus.OPEN,
        openedByWaiterId,
        openedByWaiterName,
        customerName,
        customerPhone: dto.customerPhone ? dto.customerPhone.trim() : null,
        vehicleInfo: dto.vehicleInfo ? dto.vehicleInfo.trim() : null,
        workshopVehicleId: vehicleData?.vehicleId || null,
        customerId: vehicleData?.customerId || dto.customerId || null,
        mileage: dto.mileage !== undefined ? dto.mileage : null,
        assignedWaiterId: assignedWaiter ? assignedWaiter.id : null,
        notes: dto.note ? dto.note.trim() : null,
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
        assignedWaiter: {
          select: { id: true, name: true },
        },
      },
    });

    this.logger.log(`[receiveVehicle] Vehículo ${table.number} recibido con comanda ${newOrder.id} en zona ${zone.name}`);

    const formattedOrder = this.formatOrderResponse(newOrder);
    const formattedTable = {
      id: table.id,
      businessId: table.businessId,
      number: table.number,
      capacity: table.capacity,
      shape: table.shape,
      gridX: table.gridX,
      gridY: table.gridY,
      zoneId: table.zoneId || null,
      zoneName: table.zone?.name || 'Sin zona',
      customerName: formattedOrder.customerName,
      customerPhone: formattedOrder.customerPhone,
      vehicleInfo: formattedOrder.vehicleInfo,
      assignedWaiterId: formattedOrder.assignedWaiterId,
      assignedWaiter: formattedOrder.assignedWaiter,
      workshopVehicleId: formattedOrder.workshopVehicleId,
      customerId: formattedOrder.customerId,
      mileage: formattedOrder.mileage,
      isActive: table.isActive,
      createdAt: table.createdAt,
      updatedAt: table.updatedAt,
      status: 'OCCUPIED' as const,
      order: formattedOrder,
      currentOrder: formattedOrder,
    };

    return {
      ...formattedTable,
      table: formattedTable,
      order: formattedOrder,
    };
  }

  private formatOrderResponse(order: any, taxRate: number = 0) {
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
        kitchenRoundId: item.kitchenRoundId || null,
        sentAt: item.sentAt || null,
        isSent: Boolean(item.kitchenRoundId),
        subAccountId: item.subAccountId || null,
        product: item.product
          ? {
              ...item.product,
              sendToKitchen: item.product.sendToKitchen !== false,
              stock: item.product.stock != null ? Number(item.product.stock) : undefined,
              unit: item.product.unit || 'UND',
            }
          : null,
        createdAt: item.createdAt,
      };
    });

    subtotal = Math.round(subtotal * 100) / 100;

    const discountPercent = Number(order.discountPercent || 0);
    const discountAmount = Number(order.discountAmount || 0);
    let totalDiscount = 0;
    if (discountPercent > 0) {
      totalDiscount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
    } else if (discountAmount > 0) {
      totalDiscount = Math.min(subtotal, Math.round(discountAmount * 100) / 100);
    }

    const taxable = Math.max(0, subtotal - totalDiscount);
    const taxTotal = Math.round(taxable * (taxRate / 100) * 100) / 100;
    const orderTotal = Math.round((taxable + taxTotal) * 100) / 100;

    // Formatear subcuentas con cálculo proporcional exacto al centavo
    let formattedSubAccounts: any[] = [];
    const rawSubAccounts = order.subAccounts || [];

    if (rawSubAccounts.length > 0) {
      if (order.splitMode === 'EQUAL') {
        formattedSubAccounts = rawSubAccounts.map((sa: any) => {
          const fixed = Number(sa.fixedAmount || 0);
          return {
            id: sa.id,
            label: sa.label,
            status: sa.status,
            saleId: sa.saleId || null,
            fixedAmount: fixed,
            itemsCount: 0,
            subtotal: fixed,
            discount: 0,
            tax: 0,
            total: fixed,
            createdBy: sa.createdBy,
            createdAt: sa.createdAt,
            items: [],
          };
        });
      } else {
        // Modo ITEMS
        const itemsBySub = new Map<string, any[]>();
        for (const sa of rawSubAccounts) {
          itemsBySub.set(sa.id, []);
        }
        for (const fi of formattedItems) {
          if (fi.subAccountId && itemsBySub.has(fi.subAccountId)) {
            itemsBySub.get(fi.subAccountId)!.push(fi);
          }
        }

        const sorted = [...rawSubAccounts].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
        let accDiscount = 0;
        let accTax = 0;

        formattedSubAccounts = sorted.map((sa: any, idx: number) => {
          const saItems = itemsBySub.get(sa.id) || [];
          let saSub = 0;
          let saCount = 0;
          for (const it of saItems) {
            saSub += it.subtotal;
            saCount += it.quantity;
          }
          saSub = Math.round(saSub * 100) / 100;

          const isLast = idx === sorted.length - 1;
          let saDisc = 0;
          if (subtotal > 0 && totalDiscount > 0) {
            if (isLast) {
              saDisc = Math.round((totalDiscount - accDiscount) * 100) / 100;
            } else {
              saDisc = Math.round(totalDiscount * (saSub / subtotal) * 100) / 100;
              accDiscount += saDisc;
            }
          }

          const saTaxable = Math.max(0, saSub - saDisc);
          let saTax = 0;
          if (taxRate > 0) {
            if (isLast) {
              saTax = Math.round((taxTotal - accTax) * 100) / 100;
            } else {
              saTax = Math.round(saTaxable * (taxRate / 100) * 100) / 100;
              accTax += saTax;
            }
          }

          const saTot = Math.round((saTaxable + saTax) * 100) / 100;

          return {
            id: sa.id,
            label: sa.label,
            status: sa.status,
            saleId: sa.saleId || null,
            fixedAmount: sa.fixedAmount ? Number(sa.fixedAmount) : null,
            itemsCount: saCount,
            subtotal: saSub,
            discount: saDisc,
            tax: saTax,
            total: saTot,
            createdBy: sa.createdBy,
            createdAt: sa.createdAt,
            items: saItems,
          };
        });
      }
    }

    return {
      id: order.id,
      businessId: order.businessId,
      tableId: order.tableId,
      status: order.status,
      notes: order.notes,
      openedByWaiterId: order.openedByWaiterId || null,
      openedByWaiterName: order.openedByWaiterName || null,
      customerName: order.customerName || null,
      customerPhone: order.customerPhone || null,
      vehicleInfo: order.vehicleInfo || null,
      workshopVehicleId: order.workshopVehicleId || null,
      customerId: order.customerId || null,
      mileage: order.mileage !== undefined ? order.mileage : null,
      assignedWaiterId: order.assignedWaiterId || null,
      assignedWaiter: order.assignedWaiter
        ? {
            id: order.assignedWaiter.id,
            name: order.assignedWaiter.name,
          }
        : null,
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
      subtotal,
      discountPercent,
      discountAmount,
      discountTotal: totalDiscount,
      taxRate,
      taxTotal,
      total: orderTotal,
      splitVersion: order.splitVersion !== undefined ? order.splitVersion : 0,
      splitMode: order.splitMode || null,
      subAccounts: formattedSubAccounts,
      items: formattedItems,
    };
  }

  async findFirstAvailableTechnician(businessId: string): Promise<any | null> {
    const activeWaiters = await this.prisma.waiter.findMany({
      where: {
        businessId,
        active: true,
      },
      orderBy: { name: 'asc' },
    });

    if (activeWaiters.length === 0) {
      return null;
    }

    const waiterIds = activeWaiters.map((w) => w.id);

    const openOrders = await this.prisma.tableOrder.groupBy({
      by: ['assignedWaiterId'],
      where: {
        businessId,
        assignedWaiterId: { in: waiterIds },
        status: TableOrderStatus.OPEN,
      },
      _count: { id: true },
    });

    const openCountMap = new Map<string, number>();
    for (const item of openOrders) {
      if (item.assignedWaiterId) {
        openCountMap.set(item.assignedWaiterId, item._count.id);
      }
    }

    const lastAssignments = await this.prisma.tableOrder.groupBy({
      by: ['assignedWaiterId'],
      where: {
        businessId,
        assignedWaiterId: { in: waiterIds },
      },
      _max: { createdAt: true },
    });

    const lastAssignedMap = new Map<string, number>();
    for (const item of lastAssignments) {
      if (item.assignedWaiterId && item._max.createdAt) {
        lastAssignedMap.set(item.assignedWaiterId, item._max.createdAt.getTime());
      }
    }

    const sorted = [...activeWaiters].sort((a, b) => {
      const countA = openCountMap.get(a.id) || 0;
      const countB = openCountMap.get(b.id) || 0;
      if (countA !== countB) {
        return countA - countB;
      }

      const timeA = lastAssignedMap.get(a.id) || 0;
      const timeB = lastAssignedMap.get(b.id) || 0;
      if (timeA !== timeB) {
        return timeA - timeB;
      }

      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return sorted[0] || null;
  }

  async resolveTechnician(businessId: string, technicianId?: string | null): Promise<any | null> {
    if (technicianId === undefined || technicianId === null || technicianId === '' || technicianId === 'null') {
      return null;
    }

    const trimmed = typeof technicianId === 'string' ? technicianId.trim() : technicianId;

    if (trimmed.toUpperCase() === 'AUTO') {
      return this.findFirstAvailableTechnician(businessId);
    }

    const waiter = await this.prisma.waiter.findFirst({
      where: {
        id: trimmed,
        businessId,
      },
    });

    if (!waiter) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'Técnico no encontrado',
      });
    }

    if (!waiter.active) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'El técnico seleccionado está inactivo',
      });
    }

    return waiter;
  }

  async updateOrderAssignment(
    businessId: string,
    tableId: string,
    dto: UpdateOrderAssignmentDto,
    user?: JwtPayload,
  ) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: tableId, businessId, isActive: true },
    });
    if (!table) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'Mesa o vehículo no encontrado',
      });
    }

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, status: TableOrderStatus.OPEN },
      include: {
        assignedWaiter: { select: { id: true, name: true } },
      },
    });

    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'No hay una comanda abierta para este vehículo o mesa',
      });
    }

    const updateData: any = {};

    if (dto.customerName !== undefined) {
      const trimmedName = dto.customerName?.trim();
      if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 120) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: 'El nombre del cliente debe tener entre 2 y 120 caracteres',
        });
      }
      updateData.customerName = trimmedName;
    }

    if (dto.customerPhone !== undefined) {
      updateData.customerPhone = dto.customerPhone ? dto.customerPhone.trim() : null;
    }

    if (dto.vehicleInfo !== undefined) {
      updateData.vehicleInfo = dto.vehicleInfo ? dto.vehicleInfo.trim() : null;
    }

    let technicianChanged = false;

    if (dto.technicianId !== undefined) {
      if (dto.technicianId === null || dto.technicianId === '' || dto.technicianId === 'null') {
        updateData.assignedWaiterId = null;
        technicianChanged = order.assignedWaiterId !== null;
      } else {
        const waiter = await this.resolveTechnician(businessId, dto.technicianId);
        const resolvedId = waiter ? waiter.id : null;
        updateData.assignedWaiterId = resolvedId;
        technicianChanged = order.assignedWaiterId !== resolvedId;
      }
    }

    const updatedOrder = await this.prisma.tableOrder.update({
      where: { id: order.id },
      data: updateData,
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
        assignedWaiter: {
          select: { id: true, name: true },
        },
      },
    });

    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action: technicianChanged ? 'ORDER_TECHNICIAN_REASSIGNED' : 'ORDER_ASSIGNMENT_UPDATED',
      entityType: 'TableOrder',
      entityId: order.id,
      before: {
        assignedWaiterId: order.assignedWaiterId,
        assignedWaiterName: order.assignedWaiter?.name || null,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        vehicleInfo: order.vehicleInfo,
      },
      after: {
        assignedWaiterId: updatedOrder.assignedWaiterId,
        assignedWaiterName: updatedOrder.assignedWaiter?.name || null,
        customerName: updatedOrder.customerName,
        customerPhone: updatedOrder.customerPhone,
        vehicleInfo: updatedOrder.vehicleInfo,
      },
    });

    this.logger.log(
      `[updateOrderAssignment] Comanda ${order.id} actualizada (técnico: ${order.assignedWaiterId} -> ${updatedOrder.assignedWaiterId}) por ${user?.sub || 'system'}`,
    );

    return this.formatOrderResponse(updatedOrder);
  }

  /**
   * 170a - Envía a cocina los ítems sin ronda cuyo producto tenga send_to_kitchen = true.
   * Crea una ronda con consecutivo por orden y marca los renglones como enviados.
   * Idempotente por clientRequestId.
   */
  async sendToKitchen(
    businessId: string,
    tableId: string,
    dto: SendToKitchenDto,
    user: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true, kitchenMode: true },
    });
    if (business?.salonProfile === 'TALLER') {
      throw new BadRequestException('NOT_AVAILABLE');
    }

    if (dto.clientRequestId) {
      const existingRound = await this.prisma.kitchenRound.findFirst({
        where: {
          businessId,
          clientRequestId: dto.clientRequestId.trim(),
        },
      });
      if (existingRound) {
        return {
          round: existingRound,
          tableOrder: await this.getActiveTableOrder(businessId, tableId),
        };
      }
    }

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: {
          include: {
            product: { select: { id: true, sendToKitchen: true } },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    let candidates = order.items.filter((it) => !it.kitchenRoundId);
    if (dto.itemIds && dto.itemIds.length > 0) {
      candidates = candidates.filter((it) => dto.itemIds!.includes(it.id));
    }

    const itemsToSend = candidates.filter(
      (it) => (it.product ? it.product.sendToKitchen !== false : true),
    );

    if (itemsToSend.length === 0) {
      throw new BadRequestException('NOTHING_TO_SEND');
    }

    const lastRound = await this.prisma.kitchenRound.findFirst({
      where: { tableOrderId: order.id },
      orderBy: { number: 'desc' },
    });
    const roundNumber = (lastRound?.number || 0) + 1;

    const kitchenMode = business?.kitchenMode || 'NONE';
    const printStatus = kitchenMode === 'PRINT' ? 'PENDING' : 'NOT_REQUIRED';

    const itemsJson = itemsToSend.map((item) => ({
      id: item.id,
      name: item.productName,
      quantity: Number(item.quantity),
      notes: item.notes || null,
      productId: item.productId,
    }));

    const round = await this.prisma.$transaction(async (tx) => {
      const createdRound = await tx.kitchenRound.create({
        data: {
          businessId,
          tableOrderId: order.id,
          tableId,
          number: roundNumber,
          type: 'SEND',
          status: 'SENT',
          printStatus,
          createdBy: user.sub || user.waiterName || 'unknown',
          clientRequestId: dto.clientRequestId?.trim() || null,
          items: itemsJson,
        },
      });

      const itemIdsToSend = itemsToSend.map((it) => it.id);
      await tx.tableOrderItem.updateMany({
        where: { id: { in: itemIdsToSend } },
        data: {
          kitchenRoundId: createdRound.id,
          sentAt: new Date(),
        },
      });

      return createdRound;
    });

    return {
      round,
      tableOrder: await this.getActiveTableOrder(businessId, tableId),
    };
  }

  /**
   * Obtiene las rondas de la orden de una mesa con su print_status.
   */
  async getTableOrderRounds(businessId: string, tableId: string) {
    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }
    return this.prisma.kitchenRound.findMany({
      where: { businessId, tableOrderId: order.id },
      orderBy: { number: 'asc' },
    });
  }

  /**
   * Anula un ítem de pedido.
   * Renglón sin enviar: libre sin PIN.
   * Renglón enviado: requiere CAJERO/ENCARGADO/SUPERADMIN o authorizerPin válido de uno de ellos (no mesero).
   * Límite de intentos: 5 por 5 minutos por usuario -> 429.
   * Bitácora en order_item_voids. Si kitchenMode = PRINT, crea ronda VOID.
   */
  async voidOrderItem(
    businessId: string,
    tableId: string,
    itemId: string,
    dto: VoidOrderItemDto,
    user: JwtPayload,
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

    const wasSent = Boolean(item.kitchenRoundId);
    let authorizedBy: string | null = null;

    if (!wasSent) {
      authorizedBy = null;
    } else {
      if (!dto.reason || dto.reason.trim().length < 3) {
        throw new BadRequestException('El motivo es obligatorio (mínimo 3 caracteres)');
      }

      const isStaffRole =
        user.role === UserRole.CAJERO ||
        user.role === UserRole.ENCARGADO ||
        user.role === UserRole.SUPERADMIN;

      if (isStaffRole) {
        authorizedBy = user.sub;
      } else {
        if (!dto.authorizerPin || !dto.authorizerPin.trim()) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            message: 'AUTHORIZATION_REQUIRED',
          });
        }

        const limiterKey = `${businessId}:${user.sub || 'unknown'}`;
        this.checkPinRateLimit(limiterKey);

        const staffUsers = await this.prisma.user.findMany({
          where: {
            businessId,
            isActive: true,
            role: { in: [UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN] },
          },
          select: { id: true, name: true, role: true, passwordHash: true, pinHash: true },
        });

        let matchedStaff: { id: string; name: string } | null = null;
        for (const staff of staffUsers) {
          if (staff.pinHash && (await bcrypt.compare(dto.authorizerPin.trim(), staff.pinHash))) {
            matchedStaff = staff;
            break;
          }
          if (staff.passwordHash && (await bcrypt.compare(dto.authorizerPin.trim(), staff.passwordHash))) {
            matchedStaff = staff;
            break;
          }
        }

        if (!matchedStaff) {
          this.recordPinFailure(limiterKey);
          this.logger.warn(`[voidOrderItem] PIN inválido de autorización para mesa ${tableId} por usuario ${user.sub}`);
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            message: 'INVALID_AUTHORIZATION',
          });
        }

        this.resetPinLimit(limiterKey);
        authorizedBy = matchedStaff.id;
      }
    }

    const currentQty = Number(item.quantity);
    const voidQty =
      dto.qty !== undefined && dto.qty > 0 && dto.qty < currentQty
        ? round3(dto.qty)
        : currentQty;
    const remainingQty = round3(currentQty - voidQty);

    if (remainingQty <= 0) {
      await this.prisma.tableOrderItem.delete({ where: { id: item.id } });
    } else {
      await this.prisma.tableOrderItem.update({
        where: { id: item.id },
        data: { quantity: remainingQty },
      });
    }

    await this.prisma.orderItemVoid.create({
      data: {
        businessId,
        orderId: order.id,
        tableId,
        productId: item.productId,
        productName: item.productName,
        quantity: voidQty,
        unitPrice: item.unitPrice,
        wasSent,
        reason: dto.reason?.trim() || 'Sin enviar',
        requestedBy: user.sub || user.waiterName || 'unknown',
        authorizedBy,
      },
    });

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { kitchenMode: true },
    });

    if (wasSent && business?.kitchenMode === 'PRINT') {
      const lastRound = await this.prisma.kitchenRound.findFirst({
        where: { tableOrderId: order.id },
        orderBy: { number: 'desc' },
      });
      const roundNumber = (lastRound?.number || 0) + 1;

      await this.prisma.kitchenRound.create({
        data: {
          businessId,
          tableOrderId: order.id,
          tableId,
          number: roundNumber,
          type: 'VOID',
          status: 'SENT',
          printStatus: 'PENDING',
          createdBy: user.sub || user.waiterName || 'unknown',
          items: [
            {
              id: item.id,
              name: item.productName,
              quantity: voidQty,
              notes: item.notes || null,
              productId: item.productId,
              voidReason: dto.reason?.trim() || 'Anulado',
            },
          ],
          reason: dto.reason?.trim() || null,
          authorizedBy,
        },
      });
    }

    return {
      success: true,
      voided: {
        itemId: item.id,
        productName: item.productName,
        quantity: voidQty,
      },
      tableOrder: await this.getActiveTableOrder(businessId, tableId),
    };
  }

  /**
   * 171a - Inicia la división de la orden de una mesa (ITEMS o EQUAL).
   */
  async startSplitOrder(
    businessId: string,
    tableId: string,
    dto: StartSplitDto,
    user: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true, taxRate: true },
    });
    if (business?.salonProfile === 'TALLER') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'NOT_AVAILABLE',
        message: 'La división de cuentas no está disponible para el perfil Taller',
      });
    }

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        subAccounts: true,
      },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    if (order.items.length === 0) {
      throw new BadRequestException('La orden no tiene productos para dividir');
    }

    if (dto.splitVersion !== undefined && dto.splitVersion !== order.splitVersion) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_VERSION_CONFLICT',
        message: 'La cuenta fue modificada por otro usuario. Recargue para ver los cambios.',
      });
    }

    const hasPaidAccounts = order.subAccounts.some((sa) => sa.status === 'PAID');
    if (hasPaidAccounts) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_HAS_PAID_ACCOUNTS',
        message: 'No se puede reiniciar la división porque ya existen subcuentas pagadas',
      });
    }

    const discountPercent = dto.discountPercent !== undefined ? dto.discountPercent : Number(order.discountPercent || 0);
    const discountAmount = dto.discountAmount !== undefined ? dto.discountAmount : Number(order.discountAmount || 0);

    let orderSubtotal = 0;
    for (const item of order.items) {
      orderSubtotal += Number(item.quantity) * Number(item.unitPrice);
    }
    orderSubtotal = Math.round(orderSubtotal * 100) / 100;

    let totalDiscount = 0;
    if (discountPercent > 0) {
      totalDiscount = Math.round(orderSubtotal * (discountPercent / 100) * 100) / 100;
    } else if (discountAmount > 0) {
      totalDiscount = Math.min(orderSubtotal, Math.round(discountAmount * 100) / 100);
    }

    const taxRate = business?.taxRate || 0;
    const taxable = Math.max(0, orderSubtotal - totalDiscount);
    const taxAmount = Math.round(taxable * (taxRate / 100) * 100) / 100;
    const orderTotal = Math.round((taxable + taxAmount) * 100) / 100;

    const newSplitVersion = order.splitVersion + 1;

    await this.prisma.$transaction(async (tx) => {
      await tx.tableOrderItem.updateMany({
        where: { tableOrderId: order.id },
        data: { subAccountId: null },
      });
      await tx.orderSubAccount.deleteMany({
        where: { tableOrderId: order.id },
      });

      if (dto.mode === 'ITEMS') {
        const accountA = await tx.orderSubAccount.create({
          data: {
            businessId,
            tableOrderId: order.id,
            label: 'Cuenta A',
            status: 'OPEN',
            createdBy: user?.sub || 'system',
          },
        });
        await tx.orderSubAccount.create({
          data: {
            businessId,
            tableOrderId: order.id,
            label: 'Cuenta B',
            status: 'OPEN',
            createdBy: user?.sub || 'system',
          },
        });

        await tx.tableOrderItem.updateMany({
          where: { tableOrderId: order.id },
          data: { subAccountId: accountA.id },
        });

        await tx.tableOrder.update({
          where: { id: order.id },
          data: {
            splitMode: 'ITEMS',
            splitVersion: newSplitVersion,
            discountPercent,
            discountAmount,
          },
        });

        await tx.orderSplitLog.create({
          data: {
            businessId,
            tableOrderId: order.id,
            action: 'SPLIT',
            userId: user?.sub || 'system',
            details: `División iniciada en modo ITEMS con Cuenta A y Cuenta B`,
          },
        });
      } else {
        const parts = dto.parts || 2;
        if (parts < 2 || parts > 12) {
          throw new BadRequestException('El número de partes debe ser entre 2 y 12');
        }

        const totalCents = Math.round(orderTotal * 100);
        const baseCents = Math.floor(totalCents / parts);
        const remainderCents = totalCents - baseCents * parts;

        for (let i = 0; i < parts; i++) {
          const partCents = i === parts - 1 ? baseCents + remainderCents : baseCents;
          const fixedAmount = partCents / 100;
          await tx.orderSubAccount.create({
            data: {
              businessId,
              tableOrderId: order.id,
              label: `Parte ${i + 1}`,
              status: 'OPEN',
              fixedAmount,
              createdBy: user?.sub || 'system',
            },
          });
        }

        await tx.tableOrder.update({
          where: { id: order.id },
          data: {
            splitMode: 'EQUAL',
            splitVersion: newSplitVersion,
            discountPercent,
            discountAmount,
          },
        });

        await tx.orderSplitLog.create({
          data: {
            businessId,
            tableOrderId: order.id,
            action: 'SPLIT',
            userId: user?.sub || 'system',
            details: `División iniciada en modo EQUAL en ${parts} partes (total: ${orderTotal})`,
          },
        });
      }
    });

    return this.getActiveTableOrder(businessId, tableId);
  }

  /**
   * 171a - Mueve un renglón (o cantidad) de una subcuenta a otra en modo ITEMS.
   */
  async moveSplitItem(
    businessId: string,
    tableId: string,
    dto: MoveSplitItemDto,
    user: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true },
    });
    if (business?.salonProfile === 'TALLER') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'NOT_AVAILABLE',
        message: 'La división de cuentas no está disponible para el perfil Taller',
      });
    }

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        subAccounts: true,
      },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    if (order.splitMode !== 'ITEMS') {
      throw new BadRequestException('Solo se pueden mover productos en modo ITEMS');
    }

    if (dto.splitVersion !== undefined && dto.splitVersion !== order.splitVersion) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_VERSION_CONFLICT',
        message: 'La cuenta fue modificada por otro usuario. Recargue para ver los cambios.',
      });
    }

    const destAccount = order.subAccounts.find((sa) => sa.id === dto.toSubAccountId);
    if (!destAccount) {
      throw new NotFoundException('Subcuenta de destino no encontrada');
    }
    if (destAccount.status !== 'OPEN') {
      throw new BadRequestException('No se pueden mover productos a una subcuenta pagada');
    }

    const item = order.items.find((i) => i.id === dto.itemId);
    if (!item) {
      throw new NotFoundException('Ítem de pedido no encontrado');
    }

    const sourceAccount = order.subAccounts.find((sa) => sa.id === item.subAccountId);
    if (sourceAccount && sourceAccount.status === 'PAID') {
      throw new BadRequestException('No se pueden mover productos de una subcuenta pagada');
    }

    if (item.subAccountId === dto.toSubAccountId) {
      return this.getActiveTableOrder(businessId, tableId);
    }

    const currentQty = Number(item.quantity);
    const moveQty = dto.qty !== undefined ? round3(dto.qty) : currentQty;

    if (moveQty <= 0 || moveQty > currentQty) {
      throw new BadRequestException(`Cantidad inválida para mover (disponible: ${currentQty}, solicitado: ${moveQty})`);
    }

    const newSplitVersion = order.splitVersion + 1;

    await this.prisma.$transaction(async (tx) => {
      if (moveQty === currentQty) {
        await tx.tableOrderItem.update({
          where: { id: item.id },
          data: { subAccountId: dto.toSubAccountId },
        });
      } else {
        const remainingQty = round3(currentQty - moveQty);
        await tx.tableOrderItem.update({
          where: { id: item.id },
          data: { quantity: remainingQty },
        });

        await tx.tableOrderItem.create({
          data: {
            tableOrderId: order.id,
            productId: item.productId,
            productName: item.productName,
            unitPrice: item.unitPrice,
            quantity: moveQty,
            notes: item.notes,
            waiterId: item.waiterId,
            waiterName: item.waiterName,
            kitchenRoundId: item.kitchenRoundId,
            sentAt: item.sentAt,
            subAccountId: dto.toSubAccountId,
          },
        });
      }

      await tx.tableOrder.update({
        where: { id: order.id },
        data: { splitVersion: newSplitVersion },
      });

      await tx.orderSplitLog.create({
        data: {
          businessId,
          tableOrderId: order.id,
          action: 'MOVE',
          userId: user?.sub || 'system',
          details: `Movido ${moveQty} de "${item.productName}" a "${destAccount.label}"`,
        },
      });
    });

    return this.getActiveTableOrder(businessId, tableId);
  }

  /**
   * 171a - Agrega una subcuenta adicional a la orden dividida (máximo 12).
   */
  async addSubAccount(
    businessId: string,
    tableId: string,
    dto: AddSubAccountDto,
    user: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true, taxRate: true },
    });
    if (business?.salonProfile === 'TALLER') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'NOT_AVAILABLE',
        message: 'La división de cuentas no está disponible para el perfil Taller',
      });
    }

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        subAccounts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    if (!order.splitMode) {
      throw new BadRequestException('La cuenta no ha sido dividida aún');
    }

    if (dto.splitVersion !== undefined && dto.splitVersion !== order.splitVersion) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_VERSION_CONFLICT',
        message: 'La cuenta fue modificada por otro usuario. Recargue para ver los cambios.',
      });
    }

    if (order.subAccounts.length >= 12) {
      throw new BadRequestException('Máximo 12 subcuentas permitidas');
    }

    const nextIndex = order.subAccounts.length;
    const label = dto.label?.trim() || (order.splitMode === 'ITEMS' ? `Cuenta ${String.fromCharCode(65 + nextIndex)}` : `Parte ${nextIndex + 1}`);

    const newSplitVersion = order.splitVersion + 1;

    await this.prisma.$transaction(async (tx) => {
      if (order.splitMode === 'ITEMS') {
        await tx.orderSubAccount.create({
          data: {
            businessId,
            tableOrderId: order.id,
            label,
            status: 'OPEN',
            createdBy: user?.sub || 'system',
          },
        });
      } else {
        const openAccounts = order.subAccounts.filter((sa) => sa.status === 'OPEN');
        let remainingTotal = 0;
        for (const sa of openAccounts) {
          remainingTotal += Number(sa.fixedAmount || 0);
        }
        remainingTotal = Math.round(remainingTotal * 100) / 100;

        const totalOpen = openAccounts.length + 1;
        const totalCents = Math.round(remainingTotal * 100);
        const baseCents = Math.floor(totalCents / totalOpen);
        const remainderCents = totalCents - baseCents * totalOpen;

        for (let i = 0; i < openAccounts.length; i++) {
          const partCents = baseCents;
          await tx.orderSubAccount.update({
            where: { id: openAccounts[i].id },
            data: { fixedAmount: partCents / 100 },
          });
        }

        const lastPartCents = baseCents + remainderCents;
        await tx.orderSubAccount.create({
          data: {
            businessId,
            tableOrderId: order.id,
            label,
            status: 'OPEN',
            fixedAmount: lastPartCents / 100,
            createdBy: user?.sub || 'system',
          },
        });
      }

      await tx.tableOrder.update({
        where: { id: order.id },
        data: { splitVersion: newSplitVersion },
      });

      await tx.orderSplitLog.create({
        data: {
          businessId,
          tableOrderId: order.id,
          action: 'ADD_ACCOUNT',
          userId: user?.sub || 'system',
          details: `Agregada subcuenta "${label}"`,
        },
      });
    });

    return this.getActiveTableOrder(businessId, tableId);
  }

  /**
   * 171a - Junta dos subcuentas abiertas en una sola.
   */
  async mergeSubAccounts(
    businessId: string,
    tableId: string,
    dto: MergeSubAccountsDto,
    user: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true },
    });
    if (business?.salonProfile === 'TALLER') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'NOT_AVAILABLE',
        message: 'La división de cuentas no está disponible para el perfil Taller',
      });
    }

    if (dto.fromSubAccountId === dto.toSubAccountId) {
      throw new BadRequestException('Las subcuentas origen y destino deben ser distintas');
    }

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        subAccounts: true,
      },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    if (dto.splitVersion !== undefined && dto.splitVersion !== order.splitVersion) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_VERSION_CONFLICT',
        message: 'La cuenta fue modificada por otro usuario. Recargue para ver los cambios.',
      });
    }

    const fromAccount = order.subAccounts.find((sa) => sa.id === dto.fromSubAccountId);
    const toAccount = order.subAccounts.find((sa) => sa.id === dto.toSubAccountId);

    if (!fromAccount || !toAccount) {
      throw new NotFoundException('Una o ambas subcuentas no fueron encontradas');
    }

    if (fromAccount.status !== 'OPEN' || toAccount.status !== 'OPEN') {
      throw new BadRequestException('Solo se pueden combinar subcuentas abiertas');
    }

    const newSplitVersion = order.splitVersion + 1;

    await this.prisma.$transaction(async (tx) => {
      if (order.splitMode === 'ITEMS') {
        await tx.tableOrderItem.updateMany({
          where: { tableOrderId: order.id, subAccountId: fromAccount.id },
          data: { subAccountId: toAccount.id },
        });
      } else {
        const newFixedAmount = Math.round((Number(toAccount.fixedAmount || 0) + Number(fromAccount.fixedAmount || 0)) * 100) / 100;
        await tx.orderSubAccount.update({
          where: { id: toAccount.id },
          data: { fixedAmount: newFixedAmount },
        });
      }

      await tx.orderSubAccount.delete({
        where: { id: fromAccount.id },
      });

      await tx.tableOrder.update({
        where: { id: order.id },
        data: { splitVersion: newSplitVersion },
      });

      await tx.orderSplitLog.create({
        data: {
          businessId,
          tableOrderId: order.id,
          action: 'MERGE',
          userId: user?.sub || 'system',
          details: `Subcuenta "${fromAccount.label}" combinada en "${toAccount.label}"`,
        },
      });
    });

    return this.getActiveTableOrder(businessId, tableId);
  }

  /**
   * 171a - Deshace ("rebobina") la división de la orden volviendo a una cuenta única normal.
   * Si alguna subcuenta ya está pagada -> 409 SPLIT_HAS_PAID_ACCOUNTS.
   */
  async undoSplitOrder(
    businessId: string,
    tableId: string,
    dto: UndoSplitDto,
    user: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { salonProfile: true },
    });
    if (business?.salonProfile === 'TALLER') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'NOT_AVAILABLE',
        message: 'La división de cuentas no está disponible para el perfil Taller',
      });
    }

    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
      include: {
        items: true,
        subAccounts: true,
      },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    if (dto.splitVersion !== undefined && dto.splitVersion !== order.splitVersion) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_VERSION_CONFLICT',
        message: 'La cuenta fue modificada por otro usuario. Recargue para ver los cambios.',
      });
    }

    const paidAccounts = order.subAccounts.filter((sa) => sa.status === 'PAID');
    if (paidAccounts.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SPLIT_HAS_PAID_ACCOUNTS',
        message: 'No se puede deshacer la división porque hay subcuentas pagadas',
        paidAccounts: paidAccounts.map((sa) => ({
          id: sa.id,
          label: sa.label,
          saleId: sa.saleId,
        })),
      });
    }

    const newSplitVersion = order.splitVersion + 1;

    await this.prisma.$transaction(async (tx) => {
      await tx.tableOrderItem.updateMany({
        where: { tableOrderId: order.id },
        data: { subAccountId: null },
      });

      await tx.orderSubAccount.deleteMany({
        where: { tableOrderId: order.id },
      });

      await tx.tableOrder.update({
        where: { id: order.id },
        data: {
          splitMode: null,
          splitVersion: newSplitVersion,
        },
      });

      await tx.orderSplitLog.create({
        data: {
          businessId,
          tableOrderId: order.id,
          action: 'UNDO',
          userId: user?.sub || 'system',
          details: 'División deshecha. La orden vuelve a ser cuenta única normal.',
        },
      });
    });

    return this.getActiveTableOrder(businessId, tableId);
  }

  /**
   * 171a - Establece el descuento a nivel de orden.
   */
  async setOrderDiscount(
    businessId: string,
    tableId: string,
    dto: SetOrderDiscountDto,
    user: JwtPayload,
  ) {
    const order = await this.prisma.tableOrder.findFirst({
      where: { tableId, businessId, status: TableOrderStatus.OPEN },
    });
    if (!order) {
      throw new NotFoundException('No hay un pedido abierto para esta mesa');
    }

    const discountPercent = dto.discountPercent !== undefined ? dto.discountPercent : 0;
    const discountAmount = dto.discountAmount !== undefined ? dto.discountAmount : 0;

    await this.prisma.tableOrder.update({
      where: { id: order.id },
      data: {
        discountPercent,
        discountAmount,
        splitVersion: { increment: 1 },
      },
    });

    return this.getActiveTableOrder(businessId, tableId);
  }
}


