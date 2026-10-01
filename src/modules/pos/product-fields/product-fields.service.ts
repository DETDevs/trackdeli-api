import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateProductFieldDto } from './dto/create-product-field.dto';
import { UpdateProductFieldDto } from './dto/update-product-field.dto';
import { generateFieldKey } from '../../../common/utils/field-key.util';
import { ProductFieldDataType } from '@prisma/client';

export const MAX_ACTIVE_PRODUCT_FIELDS = 15;

@Injectable()
export class ProductFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string, onlyActive: boolean = false) {
    return this.prisma.productFieldDefinition.findMany({
      where: {
        businessId,
        ...(onlyActive ? { isActive: true } : {}),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(businessId: string, id: string) {
    const field = await this.prisma.productFieldDefinition.findUnique({
      where: { id },
    });
    if (!field || field.businessId !== businessId) {
      throw new NotFoundException(`Campo de producto con ID '${id}' no encontrado`);
    }
    return field;
  }

  async create(businessId: string, dto: CreateProductFieldDto) {
    const activeCount = await this.prisma.productFieldDefinition.count({
      where: { businessId, isActive: true },
    });

    if (activeCount >= MAX_ACTIVE_PRODUCT_FIELDS) {
      throw new BadRequestException(
        `Tope máximo alcanzado: un negocio puede tener hasta ${MAX_ACTIVE_PRODUCT_FIELDS} campos dinámicos activos`,
      );
    }

    const key = dto.key ? generateFieldKey(dto.key) : generateFieldKey(dto.label);
    if (!key) {
      throw new BadRequestException('No se pudo generar una clave válida a partir de la etiqueta');
    }

    if (dto.dataType === ProductFieldDataType.SELECT) {
      if (!Array.isArray(dto.options) || dto.options.length === 0) {
        throw new BadRequestException('Para campos de tipo SELECT, las opciones son obligatorias');
      }
    }

    const existing = await this.prisma.productFieldDefinition.findUnique({
      where: {
        businessId_key: {
          businessId,
          key,
        },
      },
    });

    if (existing) {
      throw new ConflictException(
        `Ya existe un campo con la clave '${key}' en este negocio`,
      );
    }

    let nextOrder = dto.order;
    if (nextOrder === undefined || nextOrder === null) {
      const lastField = await this.prisma.productFieldDefinition.findFirst({
        where: { businessId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      nextOrder = (lastField?.order ?? -1) + 1;
    }

    return this.prisma.productFieldDefinition.create({
      data: {
        businessId,
        key,
        label: dto.label.trim(),
        dataType: dto.dataType,
        required: dto.required ?? false,
        options: dto.dataType === ProductFieldDataType.SELECT ? dto.options : null,
        order: nextOrder,
        searchable: dto.searchable ?? false,
        showInPos: dto.showInPos ?? false,
        isActive: true,
      },
    });
  }

  async update(businessId: string, id: string, dto: UpdateProductFieldDto) {
    const field = await this.findOne(businessId, id);

    // Validación de cambio de dataType si ya existen productos con valor guardado
    if (dto.dataType !== undefined && dto.dataType !== field.dataType) {
      const hasProductsWithValue: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT 1 FROM "pos_products"
         WHERE "businessId" = $1
           AND "attributes"->>$2 IS NOT NULL
           AND "attributes"->>$2 != ''
         LIMIT 1;`,
        businessId,
        field.key,
      );

      if (hasProductsWithValue.length > 0) {
        throw new BadRequestException(
          `No se puede cambiar el tipo de dato del campo '${field.label}' porque ya existen productos con valores guardados en él`,
        );
      }
    }

    const targetDataType = dto.dataType ?? field.dataType;
    if (targetDataType === ProductFieldDataType.SELECT) {
      const options = dto.options !== undefined ? dto.options : field.options;
      if (!Array.isArray(options) || options.length === 0) {
        throw new BadRequestException('Para campos de tipo SELECT, las opciones son obligatorias');
      }
    }

    return this.prisma.productFieldDefinition.update({
      where: { id },
      data: {
        ...(dto.label !== undefined && { label: dto.label.trim() }),
        ...(dto.dataType !== undefined && { dataType: dto.dataType }),
        ...(dto.required !== undefined && { required: dto.required }),
        ...(dto.options !== undefined && {
          options: targetDataType === ProductFieldDataType.SELECT ? dto.options : null,
        }),
        ...(dto.order !== undefined && { order: dto.order }),
        ...(dto.searchable !== undefined && { searchable: dto.searchable }),
        ...(dto.showInPos !== undefined && { showInPos: dto.showInPos }),
      },
    });
  }

  async deactivate(businessId: string, id: string) {
    await this.findOne(businessId, id);

    return this.prisma.productFieldDefinition.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async activate(businessId: string, id: string) {
    const field = await this.findOne(businessId, id);
    if (field.isActive) {
      return field;
    }

    const activeCount = await this.prisma.productFieldDefinition.count({
      where: { businessId, isActive: true },
    });

    if (activeCount >= MAX_ACTIVE_PRODUCT_FIELDS) {
      throw new BadRequestException(
        `Tope máximo alcanzado: un negocio puede tener hasta ${MAX_ACTIVE_PRODUCT_FIELDS} campos dinámicos activos`,
      );
    }

    return this.prisma.productFieldDefinition.update({
      where: { id },
      data: { isActive: true },
    });
  }

  async reorder(businessId: string, fieldIds: string[]) {
    // Validar que todos los IDs pertenezcan a este negocio
    const fields = await this.prisma.productFieldDefinition.findMany({
      where: {
        businessId,
        id: { in: fieldIds },
      },
      select: { id: true },
    });

    if (fields.length !== fieldIds.length) {
      throw new BadRequestException('Algunos IDs de campos no pertenecen a este negocio');
    }

    await this.prisma.$transaction(
      fieldIds.map((id, index) =>
        this.prisma.productFieldDefinition.update({
          where: { id },
          data: { order: index },
        }),
      ),
    );

    return this.findAll(businessId);
  }
}
