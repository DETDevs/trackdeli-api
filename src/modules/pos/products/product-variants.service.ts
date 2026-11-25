import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductFieldDataType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { GenerateVariantsDto } from './dto/generate-variants.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import {
  buildVariantName,
  canonicalVariantKey,
  formatVariantDetail,
  normalizeVariantText,
} from './variant.utils';

const MAX_VARIANTS_PER_PRODUCT = 100;

interface ResolvedAxisValue {
  label: string;
  optionId?: string;
}

interface ResolvedAxis {
  key: string;
  label: string;
  dataType: ProductFieldDataType;
  values: ResolvedAxisValue[];
}

@Injectable()
export class ProductVariantsService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(
    businessId: string,
    productId: string,
    dto: GenerateVariantsDto,
    userRole?: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado.');
    }

    if (product.parentProductId) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'VARIANT_CHILD_CANNOT_BE_PARENT',
        message: 'Este producto ya es una variante de otro producto y no puede tener subvariantes.',
      });
    }

    const rawAxes = dto.axes || [];
    if (rawAxes.length === 0) {
      throw new BadRequestException('Debés seleccionar al menos un eje para generar variantes.');
    }

    const seenKeys = new Set<string>();
    const cleanedAxes: Array<{ key: string; values: string[] }> = [];

    for (const axis of rawAxes) {
      const cleanKey = (axis.key || '').trim();
      if (!cleanKey) {
        throw new BadRequestException('La clave del eje no puede estar vacía.');
      }
      if (seenKeys.has(cleanKey)) {
        throw new BadRequestException(`No podés repetir el eje "${cleanKey}" más de una vez.`);
      }
      seenKeys.add(cleanKey);

      const seenNormVals = new Set<string>();
      const cleanValues: string[] = [];
      for (const rawVal of axis.values || []) {
        const trimmed = String(rawVal ?? '').trim();
        if (!trimmed) continue;
        const norm = normalizeVariantText(trimmed);
        if (!seenNormVals.has(norm)) {
          seenNormVals.add(norm);
          cleanValues.push(trimmed);
        }
      }

      if (cleanValues.length === 0) {
        throw new BadRequestException(`El eje "${cleanKey}" debe incluir al menos un valor válido.`);
      }

      cleanedAxes.push({ key: cleanKey, values: cleanValues });
    }

    const axisKeys = cleanedAxes.map((a) => a.key);
    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: {
        businessId,
        key: { in: axisKeys },
        isActive: true,
      },
      include: {
        fieldOptions: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    const fieldMap = new Map(activeFields.map((f) => [f.key, f]));

    const resolvedAxes: ResolvedAxis[] = [];
    for (const axis of cleanedAxes) {
      const field = fieldMap.get(axis.key);
      if (!field) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_VARIANT_AXIS',
          message: `El campo "${axis.key}" no existe o no está activo en este negocio.`,
        });
      }

      const resolvedValues: ResolvedAxisValue[] = [];

      if (field.dataType === ProductFieldDataType.LIST) {
        if (field.fieldOptions && field.fieldOptions.length > 0) {
          for (const rawVal of axis.values) {
            const norm = normalizeVariantText(rawVal);
            const matched = field.fieldOptions.find(
              (o) =>
                o.id === rawVal ||
                o.normalizedLabel === norm ||
                normalizeVariantText(o.label) === norm,
            );
            if (!matched) {
              throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                code: 'INVALID_VARIANT_OPTION',
                message: `El valor "${rawVal}" no está entre las opciones permitidas para "${field.label}".`,
              });
            }
            resolvedValues.push({ label: matched.label, optionId: matched.id });
          }
        } else if (Array.isArray(field.options) && field.options.length > 0) {
          const allowed = (field.options as any[])
            .map((o) => String(o ?? '').trim())
            .filter(Boolean);
          for (const rawVal of axis.values) {
            const norm = normalizeVariantText(rawVal);
            const matched = allowed.find((opt) => normalizeVariantText(opt) === norm);
            if (!matched) {
              throw new BadRequestException({
                statusCode: 400,
                error: 'Bad Request',
                code: 'INVALID_VARIANT_OPTION',
                message: `El valor "${rawVal}" no está entre las opciones permitidas para "${field.label}".`,
              });
            }
            resolvedValues.push({ label: matched });
          }
        } else {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'INVALID_VARIANT_OPTION',
            message: `El valor "${axis.values[0]}" no está entre las opciones permitidas para "${field.label}".`,
          });
        }
      } else if (
        field.dataType === ProductFieldDataType.SELECT ||
        (Array.isArray(field.options) && field.options.length > 0)
      ) {
        const allowed = Array.isArray(field.options)
          ? (field.options as any[]).map((o) => String(o ?? '').trim()).filter(Boolean)
          : [];
        for (const rawVal of axis.values) {
          const norm = normalizeVariantText(rawVal);
          const matched = allowed.find((opt) => normalizeVariantText(opt) === norm);
          if (!matched) {
            throw new BadRequestException({
              statusCode: 400,
              error: 'Bad Request',
              code: 'INVALID_VARIANT_OPTION',
              message: `El valor "${rawVal}" no está entre las opciones permitidas para "${field.label}".`,
            });
          }
          resolvedValues.push({ label: matched });
        }
      } else {
        for (const rawVal of axis.values) {
          resolvedValues.push({ label: rawVal });
        }
      }

      resolvedAxes.push({
        key: field.key,
        label: field.label,
        dataType: field.dataType,
        values: resolvedValues,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM pos_products WHERE id = ${productId} FOR UPDATE`;

      const freshParent = await tx.product.findFirst({
        where: { id: productId, businessId },
      });
      if (!freshParent) {
        throw new NotFoundException('Producto no encontrado.');
      }

      const activePresentationsCount = await tx.productPresentation.count({
        where: { businessId, productId: freshParent.id, isActive: true },
      });
      if (activePresentationsCount > 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'PRODUCT_HAS_PRESENTATIONS',
          message:
            'Este producto ya tiene presentaciones activas. Desactivalas antes de generar variantes.',
        });
      }

      const existingChildren = await tx.product.findMany({
        where: { businessId, parentProductId: freshParent.id },
        orderBy: { name: 'asc' },
      });

      let axesOrder: string[];
      let orderedAxes: ResolvedAxis[];

      if (!freshParent.isVariantParent) {
        const hasStock = Number(freshParent.stock) !== 0;
        const salesCount = await tx.saleItem.count({
          where: { productId: freshParent.id },
        });
        if (hasStock || salesCount > 0) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'PRODUCT_HAS_HISTORY',
            message:
              'Este producto ya tiene ventas o existencia. Creá uno nuevo para manejarlo con variantes.',
          });
        }
        axesOrder = resolvedAxes.map((a) => a.key);
        orderedAxes = resolvedAxes;
      } else if (
        existingChildren.length > 0 &&
        Array.isArray(freshParent.variantAxes) &&
        freshParent.variantAxes.length > 0
      ) {
        const existingAxesOrder = (freshParent.variantAxes as any[]).map((k) => String(k));
        const resolvedMap = new Map(resolvedAxes.map((a) => [a.key, a]));
        const sameKeys =
          existingAxesOrder.length === resolvedAxes.length &&
          existingAxesOrder.every((k) => resolvedMap.has(k));
        if (!sameKeys) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'VARIANT_AXES_MISMATCH',
            message: 'Los ejes deben coincidir con los ejes ya definidos para este producto.',
          });
        }
        axesOrder = existingAxesOrder;
        orderedAxes = axesOrder.map((k) => resolvedMap.get(k)!);
      } else {
        axesOrder = resolvedAxes.map((a) => a.key);
        orderedAxes = resolvedAxes;
      }

      // Calcular producto cartesiano evitando multiplicaciones desbordadas
      let estimatedTotal = 1;
      for (const ax of orderedAxes) {
        estimatedTotal *= ax.values.length;
        if (estimatedTotal > 500) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'MAX_VARIANTS_EXCEEDED',
            message: `Un producto puede tener como máximo ${MAX_VARIANTS_PER_PRODUCT} variantes.`,
          });
        }
      }

      type Combo = {
        variantValues: Record<string, string>;
        listOptionIds: Record<string, string>;
        sig: string;
      };

      let combos: Combo[] = [
        { variantValues: {}, listOptionIds: {}, sig: '' },
      ];
      for (const ax of orderedAxes) {
        const nextCombos: Combo[] = [];
        for (const prefix of combos) {
          for (const val of ax.values) {
            const nextValues = {
              ...prefix.variantValues,
              [ax.key]: val.label,
            };
            const nextOptionIds = val.optionId
              ? { ...prefix.listOptionIds, [`${ax.key}_id`]: val.optionId }
              : { ...prefix.listOptionIds };
            nextCombos.push({
              variantValues: nextValues,
              listOptionIds: nextOptionIds,
              sig: '',
            });
          }
        }
        combos = nextCombos;
      }
      for (const c of combos) {
        c.sig = canonicalVariantKey(c.variantValues);
      }

      const existingKeys = new Set(
        existingChildren.map((child) =>
          canonicalVariantKey(
            child.variantValues as Record<string, string> | null | undefined,
          ),
        ),
      );
      const missingCombos = combos.filter((c) => !existingKeys.has(c.sig));

      if (existingChildren.length + missingCombos.length > MAX_VARIANTS_PER_PRODUCT) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'MAX_VARIANTS_EXCEEDED',
          message: `Un producto puede tener como máximo ${MAX_VARIANTS_PER_PRODUCT} variantes.`,
        });
      }

      if (!freshParent.isVariantParent || existingChildren.length === 0) {
        await tx.product.update({
          where: { id: freshParent.id },
          data: {
            isVariantParent: true,
            trackStock: false,
            stock: 0,
            variantAxes: axesOrder,
          },
        });
      }

      const parentBaseAttrs =
        freshParent.attributes &&
        typeof freshParent.attributes === 'object' &&
        !Array.isArray(freshParent.attributes)
          ? { ...(freshParent.attributes as Record<string, any>) }
          : {};

      for (const combo of missingCombos) {
        const childName = buildVariantName(
          freshParent.name,
          axesOrder,
          combo.variantValues,
        );
        const childAttrs: Record<string, any> = {
          ...parentBaseAttrs,
          ...combo.variantValues,
          ...combo.listOptionIds,
        };

        await tx.product.create({
          data: {
            businessId,
            parentProductId: freshParent.id,
            isVariantParent: false,
            variantValues: combo.variantValues as Prisma.InputJsonValue,
            name: childName,
            description: freshParent.description,
            categoryId: freshParent.categoryId,
            supplierId: freshParent.supplierId,
            barcode: null,
            sku: null,
            imageUrl: freshParent.imageUrl,
            price: freshParent.price,
            cost: freshParent.cost,
            listPrice: freshParent.listPrice,
            markupPct: freshParent.markupPct,
            wholesalePrice: freshParent.wholesalePrice,
            wholesaleMinQty: freshParent.wholesaleMinQty,
            taxable: freshParent.taxable,
            taxIncluded: freshParent.taxIncluded,
            allowDiscount: freshParent.allowDiscount,
            promoDiscountPct: freshParent.promoDiscountPct,
            unit: freshParent.unit,
            type: 'PRODUCT',
            sendToKitchen: freshParent.sendToKitchen,
            trackStock: true,
            stock: 0,
            minStock: freshParent.minStock,
            maxStock: freshParent.maxStock,
            tracksBatches: freshParent.tracksBatches,
            isActive: freshParent.isActive,
            attributes: childAttrs as Prisma.InputJsonValue,
          },
        });
      }

      const allChildren = await tx.product.findMany({
        where: { businessId, parentProductId: freshParent.id },
        orderBy: { name: 'asc' },
      });

      return {
        parentId: freshParent.id,
        variantAxes: axesOrder,
        createdCount: missingCombos.length,
        skippedCount: combos.length - missingCombos.length,
        totalVariants: allChildren.length,
        variants: allChildren.map((v) => formatVariantDetail(v, userRole)),
      };
    });
  }

  async listByParent(businessId: string, parentId: string, userRole?: string) {
    const parent = await this.prisma.product.findFirst({
      where: { id: parentId, businessId },
      select: { id: true },
    });
    if (!parent) {
      throw new NotFoundException('Producto no encontrado.');
    }

    const variants = await this.prisma.product.findMany({
      where: { businessId, parentProductId: parentId },
      orderBy: { name: 'asc' },
    });

    return variants.map((v) => formatVariantDetail(v, userRole));
  }

  async updateVariant(
    businessId: string,
    parentId: string,
    variantId: string,
    dto: UpdateVariantDto,
    userRole?: string,
  ) {
    const variant = await this.prisma.product.findFirst({
      where: { id: variantId, businessId, parentProductId: parentId },
    });
    if (!variant) {
      throw new NotFoundException('Variante no encontrada.');
    }

    const data: Prisma.ProductUpdateInput = {};

    if (dto.price !== undefined) {
      data.price = dto.price;
    }

    if (dto.cost !== undefined) {
      data.cost = dto.cost;
    }

    if (dto.barcode !== undefined) {
      const cleanBarcode =
        dto.barcode === null ? null : dto.barcode.trim() || null;
      if (cleanBarcode) {
        const [existingProd, existingPres] = await Promise.all([
          this.prisma.product.findFirst({
            where: { businessId, barcode: cleanBarcode, NOT: { id: variantId } },
            select: { id: true },
          }),
          this.prisma.productPresentation.findFirst({
            where: { businessId, barcode: cleanBarcode },
            select: { id: true },
          }),
        ]);
        if (existingProd || existingPres) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'BARCODE_TAKEN',
            message: `El código de barras "${cleanBarcode}" ya está registrado.`,
          });
        }
      }
      data.barcode = cleanBarcode;
    }

    if (dto.sku !== undefined) {
      const cleanSku = dto.sku === null ? null : dto.sku.trim() || null;
      if (cleanSku) {
        const existingSku = await this.prisma.product.findFirst({
          where: { businessId, sku: cleanSku, NOT: { id: variantId } },
          select: { id: true },
        });
        if (existingSku) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'SKU_TAKEN',
            message: `El SKU "${cleanSku}" ya está registrado.`,
          });
        }
      }
      data.sku = cleanSku;
    }

    if (dto.isActive !== undefined) {
      data.isActive = Boolean(dto.isActive);
    }

    if (dto.imageUrl !== undefined) {
      data.imageUrl =
        dto.imageUrl === null ? null : dto.imageUrl.trim() || null;
    }

    const updated = await this.prisma.product.update({
      where: { id: variantId },
      data,
    });

    return formatVariantDetail(updated, userRole);
  }
}
