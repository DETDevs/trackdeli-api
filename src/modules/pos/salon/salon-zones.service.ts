import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { CreateSalonZoneDto } from './dto/create-salon-zone.dto';
import { UpdateSalonZoneDto } from './dto/update-salon-zone.dto';
import { ReorderSalonZonesDto } from './dto/reorder-salon-zones.dto';
import { TableOrderStatus } from '@prisma/client';

@Injectable()
export class SalonZonesService {
  private readonly logger = new Logger(SalonZonesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async findAll(businessId: string) {
    const zones = await this.prisma.salonZone.findMany({
      where: { businessId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        tables: {
          where: { isActive: true },
          include: {
            orders: {
              where: { status: TableOrderStatus.OPEN },
              select: { id: true },
            },
          },
        },
      },
    });

    return zones.map((z) => {
      const total = z.tables.length;
      let occupied = 0;
      for (const t of z.tables) {
        if (t.orders && t.orders.length > 0) {
          occupied++;
        }
      }
      const free = total - occupied;

      return {
        id: z.id,
        businessId: z.businessId,
        name: z.name,
        sortOrder: z.sortOrder,
        isActive: z.isActive,
        createdAt: z.createdAt,
        updatedAt: z.updatedAt,
        tablesCount: {
          total,
          free,
          occupied,
          libres: free,
          ocupadas: occupied,
        },
      };
    });
  }

  async create(businessId: string, dto: CreateSalonZoneDto, user?: JwtPayload) {
    const trimmedName = dto.name.trim();

    const existing = await this.prisma.salonZone.findFirst({
      where: {
        businessId,
        name: { equals: trimmedName, mode: 'insensitive' },
        isActive: true,
      },
    });

    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'ZONE_NAME_TAKEN',
      });
    }

    const lastZone = await this.prisma.salonZone.findFirst({
      where: { businessId, isActive: true },
      orderBy: { sortOrder: 'desc' },
    });
    const sortOrder = lastZone ? lastZone.sortOrder + 1 : 0;

    const zone = await this.prisma.salonZone.create({
      data: {
        businessId,
        name: trimmedName,
        sortOrder,
        isActive: true,
      },
    });

    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action: 'SALON_ZONE_CREATED',
      entityType: 'SalonZone',
      entityId: zone.id,
      after: { name: zone.name, sortOrder: zone.sortOrder },
    });

    this.logger.log(`[SalonZonesService] Zona creada: id=${zone.id} (${zone.name}) en businessId=${businessId}`);

    return {
      id: zone.id,
      businessId: zone.businessId,
      name: zone.name,
      sortOrder: zone.sortOrder,
      isActive: zone.isActive,
      createdAt: zone.createdAt,
      updatedAt: zone.updatedAt,
      tablesCount: {
        total: 0,
        free: 0,
        occupied: 0,
        libres: 0,
        ocupadas: 0,
      },
    };
  }

  async reorder(businessId: string, dto: ReorderSalonZonesDto, user?: JwtPayload) {
    const zones = await this.prisma.salonZone.findMany({
      where: {
        id: { in: dto.ids },
        businessId,
        isActive: true,
      },
    });

    if (zones.length !== dto.ids.length) {
      throw new NotFoundException('ZONE_NOT_FOUND');
    }

    await this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.salonZone.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );

    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action: 'SALON_ZONES_REORDERED',
      entityType: 'SalonZone',
      after: { orderedIds: dto.ids },
    });

    this.logger.log(`[SalonZonesService] Zonas reordenadas en businessId=${businessId}: ${dto.ids.join(', ')}`);

    return this.findAll(businessId);
  }

  async update(businessId: string, id: string, dto: UpdateSalonZoneDto, user?: JwtPayload) {
    const zone = await this.prisma.salonZone.findFirst({
      where: { id, businessId, isActive: true },
    });

    if (!zone) {
      throw new NotFoundException('ZONE_NOT_FOUND');
    }

    if (dto.name) {
      const trimmedName = dto.name.trim();
      if (trimmedName.toLowerCase() !== zone.name.toLowerCase()) {
        const existing = await this.prisma.salonZone.findFirst({
          where: {
            businessId,
            name: { equals: trimmedName, mode: 'insensitive' },
            isActive: true,
            id: { not: id },
          },
        });

        if (existing) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message: 'ZONE_NAME_TAKEN',
          });
        }
      }
    }

    const updated = await this.prisma.salonZone.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: {
        tables: {
          where: { isActive: true },
          include: {
            orders: {
              where: { status: TableOrderStatus.OPEN },
              select: { id: true },
            },
          },
        },
      },
    });

    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action: 'SALON_ZONE_UPDATED',
      entityType: 'SalonZone',
      entityId: id,
      before: { name: zone.name, sortOrder: zone.sortOrder, isActive: zone.isActive },
      after: { name: updated.name, sortOrder: updated.sortOrder, isActive: updated.isActive },
    });

    const total = updated.tables.length;
    let occupied = 0;
    for (const t of updated.tables) {
      if (t.orders && t.orders.length > 0) occupied++;
    }
    const free = total - occupied;

    return {
      id: updated.id,
      businessId: updated.businessId,
      name: updated.name,
      sortOrder: updated.sortOrder,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      tablesCount: {
        total,
        free,
        occupied,
        libres: free,
        ocupadas: occupied,
      },
    };
  }

  async delete(businessId: string, id: string, user?: JwtPayload) {
    const zone = await this.prisma.salonZone.findFirst({
      where: { id, businessId, isActive: true },
    });

    if (!zone) {
      throw new NotFoundException('ZONE_NOT_FOUND');
    }

    const tablesCount = await this.prisma.restaurantTable.count({
      where: { zoneId: id, isActive: true },
    });

    if (tablesCount > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'ZONE_HAS_TABLES',
        tablesCount,
      });
    }

    const totalBusinessTables = await this.prisma.restaurantTable.count({
      where: { businessId, isActive: true },
    });
    const totalActiveZones = await this.prisma.salonZone.count({
      where: { businessId, isActive: true },
    });

    if (totalBusinessTables > 0 && totalActiveZones <= 1) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'ZONE_HAS_TABLES',
        tablesCount: totalBusinessTables,
      });
    }

    await this.prisma.salonZone.update({
      where: { id },
      data: {
        isActive: false,
        name: `${zone.name}_deleted_${Date.now()}`,
      },
    });

    await this.auditService.record({
      businessId,
      userId: user?.sub || 'system',
      userRole: user?.role || 'ENCARGADO',
      action: 'SALON_ZONE_DELETED',
      entityType: 'SalonZone',
      entityId: id,
      before: { name: zone.name },
    });

    this.logger.log(`[SalonZonesService] Zona eliminada: id=${id} en businessId=${businessId}`);

    return {
      success: true,
      message: 'Zona eliminada exitosamente',
    };
  }
}
