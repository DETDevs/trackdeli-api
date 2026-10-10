import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizePlate } from './workshop.util';
import { UpdateWorkshopVehicleDto } from './dto/update-workshop-vehicle.dto';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';

@Injectable()
export class WorkshopService {
  private readonly logger = new Logger(WorkshopService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resuelve o crea el vehículo y cliente al momento de recibir un vehículo en el taller.
   * Si algo falla en la gestión de la ficha, la orden no se debe perder.
   */
  async ensureVehicleOnReceive(
    businessId: string,
    data: {
      number: string;
      customerName: string;
      customerPhone?: string | null;
      customerId?: string | null;
      vehicleInfo?: string | null;
      mileage?: number | null;
    },
  ): Promise<{ vehicleId: string; customerId: string | null } | null> {
    try {
      const rawPlate = data.number?.trim();
      const normalized = normalizePlate(rawPlate);
      if (!normalized) {
        return null;
      }

      // 1. Resolver o crear el Cliente
      let customer: any = null;
      if (data.customerId) {
        customer = await this.prisma.customer.findFirst({
          where: { id: data.customerId, businessId },
        });
      }

      const phone = data.customerPhone?.trim() || null;
      const customerName = data.customerName?.trim();

      if (!customer && phone) {
        customer = await this.prisma.customer.findFirst({
          where: { businessId, phone },
        });
      }

      if (!customer && customerName) {
        try {
          customer = await this.prisma.customer.create({
            data: {
              businessId,
              name: customerName,
              phone,
            },
          });
          this.logger.log(`[ensureVehicleOnReceive] Cliente creado: id=${customer.id} name=${customer.name}`);
        } catch (createCustErr: any) {
          this.logger.warn(`[ensureVehicleOnReceive] No se pudo crear cliente: ${createCustErr.message}`);
          if (phone) {
            customer = await this.prisma.customer.findFirst({
              where: { businessId, phone },
            });
          }
        }
      }

      // 2. Resolver o crear/actualizar el Vehículo
      let vehicle = await this.prisma.workshopVehicle.findUnique({
        where: {
          businessId_normalizedPlate: {
            businessId,
            normalizedPlate: normalized,
          },
        },
      });

      const description = data.vehicleInfo?.trim() || null;
      const mileage = data.mileage !== undefined && data.mileage !== null ? data.mileage : undefined;

      if (vehicle) {
        const updateData: any = {
          plate: rawPlate,
          updatedAt: new Date(),
        };
        if (description) updateData.description = description;
        if (customer) updateData.customerId = customer.id;
        if (mileage !== undefined) updateData.lastMileage = mileage;

        vehicle = await this.prisma.workshopVehicle.update({
          where: { id: vehicle.id },
          data: updateData,
        });
        this.logger.log(`[ensureVehicleOnReceive] Vehículo actualizado: id=${vehicle.id} plate=${vehicle.plate}`);
      } else {
        vehicle = await this.prisma.workshopVehicle.create({
          data: {
            businessId,
            plate: rawPlate,
            normalizedPlate: normalized,
            description,
            customerId: customer?.id || null,
            lastMileage: mileage ?? null,
          },
        });
        this.logger.log(`[ensureVehicleOnReceive] Vehículo creado: id=${vehicle.id} plate=${vehicle.plate}`);
      }

      return {
        vehicleId: vehicle.id,
        customerId: customer?.id || vehicle.customerId || null,
      };
    } catch (err: any) {
      this.logger.error(`[ensureVehicleOnReceive] Error al registrar ficha de vehículo/cliente: ${err.message}`, err.stack);
      return null;
    }
  }

  /**
   * GET /pos/workshop/vehicles?search=
   * Busca por placa, nombre de cliente o teléfono. Máximo 20 resultados.
   */
  async getVehicles(businessId: string, search?: string) {
    const where: any = { businessId };

    if (search && search.trim()) {
      const q = search.trim();
      const norm = normalizePlate(q);

      where.OR = [
        { plate: { contains: q, mode: 'insensitive' } },
        ...(norm ? [{ normalizedPlate: { contains: norm, mode: 'insensitive' } }] : []),
        { description: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { customer: { phone: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const vehicles = await this.prisma.workshopVehicle.findMany({
      where,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        tableOrders: {
          select: {
            id: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: {
          select: { tableOrders: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return vehicles.map((v) => ({
      id: v.id,
      plate: v.plate,
      normalizedPlate: v.normalizedPlate,
      description: v.description,
      customer: v.customer
        ? {
            id: v.customer.id,
            name: v.customer.name,
            phone: v.customer.phone,
          }
        : null,
      lastMileage: v.lastMileage,
      visitCount: v._count.tableOrders,
      lastVisitAt: v.tableOrders[0]?.createdAt || null,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));
  }

  /**
   * GET /pos/workshop/vehicles/:id
   * Ficha completa del vehículo y de su cliente actual.
   */
  async getVehicleById(businessId: string, id: string) {
    const vehicle = await this.prisma.workshopVehicle.findFirst({
      where: { id, businessId },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            ruc: true,
            notes: true,
          },
        },
        tableOrders: {
          select: {
            id: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: {
          select: { tableOrders: true },
        },
      },
    });

    if (!vehicle) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'VEHICLE_NOT_FOUND',
      });
    }

    return {
      id: vehicle.id,
      businessId: vehicle.businessId,
      plate: vehicle.plate,
      normalizedPlate: vehicle.normalizedPlate,
      description: vehicle.description,
      lastMileage: vehicle.lastMileage,
      createdAt: vehicle.createdAt,
      updatedAt: vehicle.updatedAt,
      customer: vehicle.customer
        ? {
            id: vehicle.customer.id,
            name: vehicle.customer.name,
            phone: vehicle.customer.phone,
            email: vehicle.customer.email,
            ruc: vehicle.customer.ruc,
            notes: vehicle.customer.notes,
          }
        : null,
      visitCount: vehicle._count.tableOrders,
      lastVisitAt: vehicle.tableOrders[0]?.createdAt || null,
    };
  }

  /**
   * GET /pos/workshop/vehicles/:id/history?page=&limit=
   * Historial de visitas ordenadas de la más reciente a la más antigua.
   */
  async getVehicleHistory(businessId: string, id: string, page = 1, limit = 20) {
    const vehicle = await this.prisma.workshopVehicle.findFirst({
      where: { id, businessId },
      select: { id: true, plate: true },
    });

    if (!vehicle) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'VEHICLE_NOT_FOUND',
      });
    }

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [total, orders] = await Promise.all([
      this.prisma.tableOrder.count({
        where: { workshopVehicleId: id, businessId },
      }),
      this.prisma.tableOrder.findMany({
        where: { workshopVehicleId: id, businessId },
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true, unit: true },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          assignedWaiter: {
            select: { id: true, name: true },
          },
          customer: {
            select: { id: true, name: true, phone: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
    ]);

    // Consultar ventas enlazadas si existen
    const saleIds = orders.map((o) => o.saleId).filter(Boolean) as string[];
    const sales = saleIds.length > 0
      ? await this.prisma.sale.findMany({
          where: { id: { in: saleIds }, businessId },
          select: {
            id: true,
            invoiceNumber: true,
            subtotal: true,
            taxAmount: true,
            total: true,
            status: true,
            paymentMethod: true,
            createdAt: true,
          },
        })
      : [];
    const salesMap = new Map(sales.map((s) => [s.id, s]));

    const data = orders.map((o) => {
      const sale = o.saleId ? salesMap.get(o.saleId) : null;
      const items = (o.items || []).map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.productName,
        quantity: Number(i.quantity),
        unitPrice: Number(i.unitPrice),
        total: Math.round(Number(i.quantity) * Number(i.unitPrice) * 100) / 100,
        notes: i.notes,
      }));
      const itemsSubtotal = items.reduce((acc, curr) => acc + curr.total, 0);

      return {
        id: o.id,
        date: o.createdAt,
        closedAt: o.closedAt,
        status: o.status,
        mileage: o.mileage,
        technician: o.assignedWaiter
          ? {
              id: o.assignedWaiter.id,
              name: o.assignedWaiter.name,
            }
          : null,
        customerName: o.customerName || o.customer?.name || null,
        customerPhone: o.customerPhone || o.customer?.phone || null,
        notes: o.notes,
        items,
        sale: sale
          ? {
              id: sale.id,
              invoiceNumber: sale.invoiceNumber,
              subtotal: sale.subtotal,
              taxAmount: sale.taxAmount,
              total: sale.total,
              status: sale.status,
              paymentMethod: sale.paymentMethod,
            }
          : null,
        total: sale ? sale.total : Math.round(itemsSubtotal * 100) / 100,
      };
    });

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    };
  }

  /**
   * PATCH /pos/workshop/vehicles/:id
   * Corrige descripción, placa (revalidando unicidad) y cliente asociado.
   */
  async updateVehicle(
    businessId: string,
    id: string,
    dto: UpdateWorkshopVehicleDto,
    user?: JwtPayload,
  ) {
    const vehicle = await this.prisma.workshopVehicle.findFirst({
      where: { id, businessId },
    });

    if (!vehicle) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'VEHICLE_NOT_FOUND',
      });
    }

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (dto.plate !== undefined && dto.plate.trim()) {
      const newPlate = dto.plate.trim();
      const newNormalized = normalizePlate(newPlate);
      if (!newNormalized) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: 'INVALID_PLATE',
        });
      }

      if (newNormalized !== vehicle.normalizedPlate) {
        const existingWithPlate = await this.prisma.workshopVehicle.findUnique({
          where: {
            businessId_normalizedPlate: {
              businessId,
              normalizedPlate: newNormalized,
            },
          },
        });
        if (existingWithPlate && existingWithPlate.id !== vehicle.id) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message: 'PLATE_ALREADY_EXISTS',
          });
        }
      }

      updateData.plate = newPlate;
      updateData.normalizedPlate = newNormalized;
    }

    if (dto.description !== undefined) {
      updateData.description = dto.description?.trim() || null;
    }

    if (dto.lastMileage !== undefined) {
      updateData.lastMileage = dto.lastMileage;
    }

    // Actualización / asignación de cliente
    if (dto.customerId !== undefined) {
      if (dto.customerId === null) {
        updateData.customerId = null;
      } else {
        const cust = await this.prisma.customer.findFirst({
          where: { id: dto.customerId, businessId },
        });
        if (!cust) {
          throw new NotFoundException({
            statusCode: 404,
            error: 'Not Found',
            message: 'CUSTOMER_NOT_FOUND',
          });
        }
        updateData.customerId = cust.id;
      }
    } else if (dto.customerName && dto.customerName.trim()) {
      const cName = dto.customerName.trim();
      const cPhone = dto.customerPhone?.trim() || null;

      if (vehicle.customerId) {
        await this.prisma.customer.update({
          where: { id: vehicle.customerId },
          data: {
            name: cName,
            ...(cPhone ? { phone: cPhone } : {}),
          },
        });
      } else {
        const newCustomer = await this.prisma.customer.create({
          data: {
            businessId,
            name: cName,
            phone: cPhone,
          },
        });
        updateData.customerId = newCustomer.id;
      }
    }

    const updated = await this.prisma.workshopVehicle.update({
      where: { id: vehicle.id },
      data: updateData,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
    });

    this.logger.log(
      `[updateVehicle] Vehículo ${updated.plate} (${updated.id}) actualizado por ${user?.sub || 'user'}`,
    );

    return updated;
  }

  /**
   * GET /pos/workshop/customers/:id
   * Devuelve ficha del cliente con todos sus vehículos registrados.
   */
  async getCustomerWithVehicles(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: {
        id: true,
        businessId: true,
        name: true,
        phone: true,
        email: true,
        notes: true,
        creditLimit: true,
        createdAt: true,
      },
    });

    if (!customer) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'CUSTOMER_NOT_FOUND',
      });
    }

    const vehicles = await this.prisma.workshopVehicle.findMany({
      where: { customerId, businessId },
      include: {
        tableOrders: {
          select: {
            id: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: {
          select: { tableOrders: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      ...customer,
      vehicles: vehicles.map((v) => ({
        id: v.id,
        plate: v.plate,
        normalizedPlate: v.normalizedPlate,
        description: v.description,
        lastMileage: v.lastMileage,
        visitCount: v._count.tableOrders,
        lastVisitAt: v.tableOrders[0]?.createdAt || null,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    };
  }
}
