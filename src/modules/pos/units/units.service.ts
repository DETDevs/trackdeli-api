import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { DEFAULT_SYSTEM_UNITS } from '../products/product-unit.util';

@Injectable()
export class UnitsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Siembra de forma idempotente las 10 unidades por defecto del sistema para un negocio.
   */
  async ensureDefaultUnitsForBusiness(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!businessId) return;
    const client = tx || this.prisma;
    const existingCount = await client.posUnit.count({
      where: { businessId, isSystem: true },
    });
    if (existingCount >= DEFAULT_SYSTEM_UNITS.length) {
      return;
    }
    await client.posUnit.createMany({
      data: DEFAULT_SYSTEM_UNITS.map((u) => ({
        businessId,
        code: u.code,
        name: u.name,
        allowsDecimals: u.allowsDecimals,
        isSystem: u.isSystem,
        isActive: u.isActive,
        sortOrder: u.sortOrder,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Lista las unidades del negocio ordenadas por sortOrder y name.
   * Por defecto devuelve solo las activas; ENCARGADO y SUPERADMIN pueden pedir ?includeInactive=true.
   */
  async findAll(
    businessId: string,
    includeInactive = false,
    userRole?: string,
  ) {
    await this.ensureDefaultUnitsForBusiness(businessId);

    const canSeeInactive =
      includeInactive &&
      (!userRole ||
        userRole === UserRole.ENCARGADO ||
        userRole === UserRole.SUPERADMIN);

    return this.prisma.posUnit.findMany({
      where: {
        businessId,
        ...(canSeeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Crea una unidad personalizada para el negocio.
   */
  async create(businessId: string, dto: CreateUnitDto) {
    await this.ensureDefaultUnitsForBusiness(businessId);

    const normalizedCode = (dto.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(normalizedCode)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_UNIT_CODE',
        message:
          'El código de la unidad debe tener entre 1 y 10 caracteres alfanuméricos sin espacios.',
      });
    }

    const trimmedName = (dto.name || '').trim();
    if (!trimmedName) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_UNIT_NAME',
        message: 'El nombre de la unidad es obligatorio.',
      });
    }

    const existing = await this.prisma.posUnit.findUnique({
      where: {
        businessId_code: {
          businessId,
          code: normalizedCode,
        },
      },
    });

    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'UNIT_CODE_TAKEN',
        message: `Ya existe una unidad con el código "${normalizedCode}" en este negocio.`,
      });
    }

    return this.prisma.posUnit.create({
      data: {
        businessId,
        code: normalizedCode,
        name: trimmedName,
        allowsDecimals: Boolean(dto.allowsDecimals),
        isSystem: false,
        isActive: true,
        sortOrder: dto.sortOrder !== undefined ? Number(dto.sortOrder) : 20,
      },
    });
  }

  /**
   * Edita una unidad del negocio (name, allowsDecimals, sortOrder, isActive).
   * El code no se puede cambiar. En las del sistema no se puede cambiar allowsDecimals de UND.
   */
  async update(businessId: string, id: string, dto: UpdateUnitDto) {
    await this.ensureDefaultUnitsForBusiness(businessId);

    const unit = await this.prisma.posUnit.findFirst({
      where: { id, businessId },
    });

    if (!unit) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'UNIT_NOT_FOUND',
        message: 'Unidad de medida no encontrada.',
      });
    }

    if (
      dto.code !== undefined &&
      dto.code.trim().toUpperCase() !== unit.code
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'UNIT_CODE_IMMUTABLE',
        message: 'El código de la unidad no se puede cambiar.',
      });
    }

    if (
      unit.isSystem &&
      unit.code === 'UND' &&
      dto.allowsDecimals !== undefined &&
      dto.allowsDecimals !== false
    ) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'SYSTEM_UND_NO_DECIMALS',
        message: 'En la unidad del sistema UND no se puede activar el uso de decimales.',
      });
    }

    const updateData: Prisma.PosUnitUpdateInput = {};

    if (dto.name !== undefined) {
      const trimmedName = dto.name.trim();
      if (!trimmedName) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_UNIT_NAME',
          message: 'El nombre de la unidad no puede estar vacío.',
        });
      }
      updateData.name = trimmedName;
    }

    if (dto.allowsDecimals !== undefined) {
      updateData.allowsDecimals = Boolean(dto.allowsDecimals);
    }

    if (dto.sortOrder !== undefined) {
      updateData.sortOrder = Number(dto.sortOrder);
    }

    if (dto.isActive !== undefined) {
      updateData.isActive = Boolean(dto.isActive);
    }

    return this.prisma.posUnit.update({
      where: { id: unit.id },
      data: updateData,
    });
  }

  /**
   * Borra una unidad personalizada si ningún producto la usa.
   * Si algún producto la usa -> 409 UNIT_IN_USE ("Hay productos con esta unidad. Desactivala en vez de borrarla.").
   * Las del sistema solo se desactivan.
   */
  async remove(businessId: string, id: string) {
    await this.ensureDefaultUnitsForBusiness(businessId);

    const unit = await this.prisma.posUnit.findFirst({
      where: { id, businessId },
    });

    if (!unit) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'UNIT_NOT_FOUND',
        message: 'Unidad de medida no encontrada.',
      });
    }

    const productsUsingCount = await this.prisma.product.count({
      where: {
        businessId,
        unit: {
          equals: unit.code,
          mode: 'insensitive',
        },
      },
    });

    if (productsUsingCount > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'UNIT_IN_USE',
        message: 'Hay productos con esta unidad. Desactivala en vez de borrarla.',
      });
    }

    if (unit.isSystem) {
      return this.prisma.posUnit.update({
        where: { id: unit.id },
        data: { isActive: false },
      });
    }

    await this.prisma.posUnit.delete({
      where: { id: unit.id },
    });

    return { deleted: true, id: unit.id, code: unit.code };
  }

  /**
   * Busca una unidad por código para un negocio (asegurando antes las 10 unidades por defecto).
   */
  async findByCode(
    businessId: string,
    code: string | null | undefined,
    tx?: Prisma.TransactionClient,
  ) {
    await this.ensureDefaultUnitsForBusiness(businessId, tx);
    const normalizedCode = (code || 'UND').trim().toUpperCase();
    const client = tx || this.prisma;
    return client.posUnit.findUnique({
      where: {
        businessId_code: {
          businessId,
          code: normalizedCode,
        },
      },
    });
  }

  /**
   * Obtiene un mapa code -> PosUnit de todas las unidades del negocio (activas e inactivas).
   */
  async getUnitsMap(
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, { code: string; name: string; allowsDecimals: boolean; isActive: boolean; isSystem: boolean }>> {
    await this.ensureDefaultUnitsForBusiness(businessId, tx);
    const client = tx || this.prisma;
    const units = await client.posUnit.findMany({
      where: { businessId },
      select: {
        code: true,
        name: true,
        allowsDecimals: true,
        isActive: true,
        isSystem: true,
      },
    });
    const map = new Map<string, { code: string; name: string; allowsDecimals: boolean; isActive: boolean; isSystem: boolean }>();
    for (const u of units) {
      map.set(u.code.toUpperCase(), u);
    }
    return map;
  }
}
