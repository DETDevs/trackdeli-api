import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateProductFieldDto } from './dto/create-product-field.dto';
import { UpdateProductFieldDto } from './dto/update-product-field.dto';
import { CreateFieldOptionDto } from './dto/create-field-option.dto';
import { UpdateFieldOptionDto } from './dto/update-field-option.dto';
import { generateFieldKey, normalizeOptionLabel } from '../../../common/utils/field-key.util';
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
      include: {
        fieldOptions: {
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        },
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(businessId: string, id: string) {
    const field = await this.prisma.productFieldDefinition.findUnique({
      where: { id },
      include: {
        fieldOptions: {
          orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
        },
      },
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
        allowCreateInline: dto.allowCreateInline !== undefined ? dto.allowCreateInline : true,
        isActive: true,
      },
    });
  }

  async update(businessId: string, id: string, dto: UpdateProductFieldDto) {
    const field = await this.findOne(businessId, id);

    // Validación de cambio de dataType si ya existen productos con valor guardado
    // Nota: Se permite migrar de TEXT a LIST
    if (dto.dataType !== undefined && dto.dataType !== field.dataType) {
      const isUpgradingTextToList =
        field.dataType === ProductFieldDataType.TEXT &&
        dto.dataType === ProductFieldDataType.LIST;

      if (!isUpgradingTextToList) {
        const hasProductsWithValue: any[] = await this.prisma.$queryRawUnsafe(
          `SELECT 1 FROM "products"
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
    }

    const targetDataType = dto.dataType ?? field.dataType;
    if (targetDataType === ProductFieldDataType.SELECT) {
      const options = dto.options !== undefined ? dto.options : field.options;
      if (!Array.isArray(options) || options.length === 0) {
        throw new BadRequestException('Para campos de tipo SELECT, las opciones son obligatorias');
      }
    }

    const updated = await this.prisma.productFieldDefinition.update({
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
        ...(dto.allowCreateInline !== undefined && { allowCreateInline: dto.allowCreateInline }),
      },
    });

    // Si se actualizó de TEXT a LIST, migrar automáticamente textos libres a opciones
    if (field.dataType === ProductFieldDataType.TEXT && dto.dataType === ProductFieldDataType.LIST) {
      await this.migrateExistingTextValuesToOptions(businessId, id);
    }

    return updated;
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

  // ========================================================
  // CRUD de Opciones de Campos Dinámicos (tipo LIST)
  // ========================================================

  async findOptions(businessId: string, fieldId: string, onlyActive: boolean = false) {
    const field = await this.findOne(businessId, fieldId);
    if (field.dataType !== ProductFieldDataType.LIST) {
      throw new BadRequestException(`El campo '${field.label}' no es de tipo LIST`);
    }

    return this.prisma.productFieldOption.findMany({
      where: {
        businessId,
        fieldDefinitionId: fieldId,
        ...(onlyActive ? { isActive: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async createOption(businessId: string, fieldId: string, dto: CreateFieldOptionDto) {
    const field = await this.findOne(businessId, fieldId);
    if (field.dataType !== ProductFieldDataType.LIST) {
      throw new BadRequestException(`El campo '${field.label}' no es de tipo LIST`);
    }

    const label = dto.label.trim();
    const normalizedLabel = normalizeOptionLabel(label);
    if (!normalizedLabel) {
      throw new BadRequestException('La etiqueta de la opción no puede estar vacía');
    }

    const existing = await this.prisma.productFieldOption.findUnique({
      where: {
        businessId_fieldDefinitionId_normalizedLabel: {
          businessId,
          fieldDefinitionId: fieldId,
          normalizedLabel,
        },
      },
    });

    if (existing) {
      if (existing.isActive) {
        throw new ConflictException(
          `Ya existe una opción con el nombre '${existing.label}' para el campo '${field.label}'`,
        );
      }
      // Reactivar opción existente que estaba inactiva
      return this.prisma.productFieldOption.update({
        where: { id: existing.id },
        data: {
          label,
          isActive: true,
          sortOrder: dto.sortOrder !== undefined ? dto.sortOrder : existing.sortOrder,
        },
      });
    }

    let sortOrder = dto.sortOrder;
    if (sortOrder === undefined || sortOrder === null) {
      const last = await this.prisma.productFieldOption.findFirst({
        where: { businessId, fieldDefinitionId: fieldId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    return this.prisma.productFieldOption.create({
      data: {
        businessId,
        fieldDefinitionId: fieldId,
        label,
        normalizedLabel,
        sortOrder,
        isActive: true,
      },
    });
  }

  async updateOption(businessId: string, fieldId: string, optionId: string, dto: UpdateFieldOptionDto) {
    const field = await this.findOne(businessId, fieldId);
    if (field.dataType !== ProductFieldDataType.LIST) {
      throw new BadRequestException(`El campo '${field.label}' no es de tipo LIST`);
    }

    const option = await this.prisma.productFieldOption.findFirst({
      where: { id: optionId, fieldDefinitionId: fieldId, businessId },
    });
    if (!option) {
      throw new NotFoundException(`Opción con ID '${optionId}' no encontrada`);
    }

    let newLabel = option.label;
    let newNormalizedLabel = option.normalizedLabel;
    const isRenaming = dto.label !== undefined && dto.label.trim() !== option.label;

    if (isRenaming) {
      newLabel = dto.label!.trim();
      newNormalizedLabel = normalizeOptionLabel(newLabel);
      if (!newNormalizedLabel) {
        throw new BadRequestException('La etiqueta de la opción no puede estar vacía');
      }

      const duplicate = await this.prisma.productFieldOption.findFirst({
        where: {
          businessId,
          fieldDefinitionId: fieldId,
          normalizedLabel: newNormalizedLabel,
          id: { not: optionId },
        },
      });

      if (duplicate) {
        throw new ConflictException(
          `Ya existe otra opción con el nombre '${duplicate.label}' para el campo '${field.label}'`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.productFieldOption.update({
        where: { id: optionId },
        data: {
          label: newLabel,
          normalizedLabel: newNormalizedLabel,
          sortOrder: dto.sortOrder !== undefined ? dto.sortOrder : undefined,
          isActive: dto.isActive !== undefined ? dto.isActive : undefined,
        },
      });

      // Si se renombró, actualizar la etiqueta en todos los productos que la usan
      if (isRenaming) {
        await tx.$executeRawUnsafe(
          `UPDATE "pos_products"
           SET "attributes" = jsonb_set(
             "attributes"::jsonb,
             ARRAY[$1],
             to_jsonb($2::text)
           )
           WHERE "businessId" = $3
             AND ("attributes"->>$1 = $4 OR "attributes"->>$5 = $6);`,
          field.key,
          newLabel,
          businessId,
          option.label,
          `${field.key}_id`,
          option.id,
        );
      }

      return updated;
    });
  }

  async deactivateOption(businessId: string, fieldId: string, optionId: string) {
    return this.updateOption(businessId, fieldId, optionId, { isActive: false });
  }

  async activateOption(businessId: string, fieldId: string, optionId: string) {
    return this.updateOption(businessId, fieldId, optionId, { isActive: true });
  }

  async deleteOption(businessId: string, fieldId: string, optionId: string) {
    const field = await this.findOne(businessId, fieldId);
    const option = await this.prisma.productFieldOption.findFirst({
      where: { id: optionId, fieldDefinitionId: fieldId, businessId },
    });
    if (!option) {
      throw new NotFoundException(`Opción con ID '${optionId}' no encontrada`);
    }

    const inUse = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT 1 FROM "pos_products"
       WHERE "businessId" = $1
         AND ("attributes"->>$2 = $3 OR "attributes"->>$4 = $5)
       LIMIT 1;`,
      businessId,
      field.key,
      option.label,
      `${field.key}_id`,
      option.id,
    );

    if (inUse.length > 0) {
      throw new BadRequestException(
        'No se puede eliminar la opción porque está en uso por uno o más productos. Desactívela en su lugar.',
      );
    }

    return this.prisma.productFieldOption.delete({
      where: { id: optionId },
    });
  }

  // ========================================================
  // Aplicar Plantilla de Industria y Migración de Textos
  // ========================================================

  async applyIndustryTemplate(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        industry: {
          include: {
            fieldTemplates: { orderBy: { order: 'asc' } },
          },
        },
      },
    });

    if (!business || !business.industry) {
      throw new BadRequestException('El negocio no tiene una industria asignada');
    }

    const templates = business.industry.fieldTemplates;
    const existingFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId },
    });
    const fieldMap = new Map(existingFields.map((f) => [f.key, f]));

    const appliedFields: any[] = [];
    let totalMigratedOptions = 0;

    for (const tmpl of templates) {
      const existing = fieldMap.get(tmpl.key);
      if (existing) {
        const shouldUpgrade =
          tmpl.dataType === ProductFieldDataType.LIST &&
          existing.dataType !== ProductFieldDataType.LIST;

        await this.prisma.productFieldDefinition.update({
          where: { id: existing.id },
          data: {
            dataType: tmpl.dataType,
            allowCreateInline: tmpl.allowCreateInline ?? true,
            label: tmpl.label,
          },
        });
        appliedFields.push({ key: tmpl.key, action: shouldUpgrade ? 'UPGRADED_TO_LIST' : 'UPDATED' });

        if (shouldUpgrade) {
          const migRes = await this.migrateExistingTextValuesToOptions(businessId, existing.id);
          totalMigratedOptions += migRes.createdOptions;
        }
      } else {
        const activeCount = await this.prisma.productFieldDefinition.count({
          where: { businessId, isActive: true },
        });
        if (activeCount < MAX_ACTIVE_PRODUCT_FIELDS) {
          await this.prisma.productFieldDefinition.create({
            data: {
              businessId,
              key: tmpl.key,
              label: tmpl.label,
              dataType: tmpl.dataType,
              required: tmpl.required,
              options: tmpl.options as any,
              order: tmpl.order,
              searchable: tmpl.searchable,
              showInPos: tmpl.showInPos,
              allowCreateInline: tmpl.allowCreateInline ?? true,
              isActive: true,
            },
          });
          appliedFields.push({ key: tmpl.key, action: 'CREATED' });
        }
      }
    }

    return {
      businessId,
      industry: business.industry.name,
      appliedFields,
      totalMigratedOptions,
    };
  }

  async migrateExistingTextValuesToOptions(businessId: string, fieldId?: string) {
    const fields = await this.prisma.productFieldDefinition.findMany({
      where: {
        businessId,
        dataType: ProductFieldDataType.LIST,
        ...(fieldId ? { id: fieldId } : {}),
      },
    });

    let totalCreatedOptions = 0;
    let totalUpdatedProducts = 0;
    const details: any[] = [];

    for (const field of fields) {
      const products = await this.prisma.product.findMany({
        where: {
          businessId,
          NOT: { attributes: { equals: {} } },
        },
        select: { id: true, attributes: true },
      });

      const prodsWithVal = products.filter((p) => {
        const raw = (p.attributes as any)?.[field.key];
        return typeof raw === 'string' && raw.trim().length > 0;
      });

      const groups = new Map<string, { label: string; productIds: string[] }>();
      for (const p of prodsWithVal) {
        const raw = String((p.attributes as any)[field.key]).trim();
        const norm = normalizeOptionLabel(raw);
        if (!norm) continue;
        if (!groups.has(norm)) {
          groups.set(norm, { label: raw, productIds: [] });
        }
        groups.get(norm)!.productIds.push(p.id);
      }

      let fieldCreated = 0;
      for (const [norm, g] of groups.entries()) {
        let opt = await this.prisma.productFieldOption.findUnique({
          where: {
            businessId_fieldDefinitionId_normalizedLabel: {
              businessId,
              fieldDefinitionId: field.id,
              normalizedLabel: norm,
            },
          },
        });

        if (!opt) {
          const last = await this.prisma.productFieldOption.findFirst({
            where: { businessId, fieldDefinitionId: field.id },
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true },
          });
          const nextOrder = (last?.sortOrder ?? -1) + 1;

          opt = await this.prisma.productFieldOption.create({
            data: {
              businessId,
              fieldDefinitionId: field.id,
              label: g.label,
              normalizedLabel: norm,
              sortOrder: nextOrder,
              isActive: true,
            },
          });
          fieldCreated++;
          totalCreatedOptions++;
        }

        for (const pId of g.productIds) {
          await this.prisma.$executeRawUnsafe(
            `UPDATE "pos_products"
             SET "attributes" = jsonb_set(
               jsonb_set(
                 "attributes"::jsonb,
                 ARRAY[$1],
                 to_jsonb($2::text)
               ),
               ARRAY[$3],
               to_jsonb($4::text)
             )
             WHERE "id" = $5;`,
            field.key,
            opt.label,
            `${field.key}_id`,
            opt.id,
            pId,
          );
          totalUpdatedProducts++;
        }
      }

      details.push({
        fieldKey: field.key,
        fieldLabel: field.label,
        distinctValuesFound: groups.size,
        optionsCreated: fieldCreated,
        productsMigrated: prodsWithVal.length,
      });
    }

    return {
      businessId,
      createdOptions: totalCreatedOptions,
      updatedProducts: totalUpdatedProducts,
      details,
    };
  }
}

