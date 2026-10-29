import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
} from "@nestjs/common";
import { BusinessProductType, PosVertical, Prisma, ProductFieldDataType, StockMovementType, UserRole } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { JwtPayload } from "../../../common/types/jwt-payload.interface";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { AdjustStockDto } from "./dto/adjust-stock.dto";
import { SetRecipeComponentsDto } from "./dto/set-recipe-components.dto";
import { BulkUpdateProductsDto } from "./dto/bulk-update-products.dto";
import { validateProductQuantity, round3 } from "./product-unit.util";

import { BatchesService } from '../batches/batches.service';
import { buildBusinessDateRange, formatDateInTimezone } from '../../../common/utils/date.util';
import { normalizeOptionLabel } from '../../../common/utils/field-key.util';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly batchesService: BatchesService,
  ) { }

  private mapProductWithInventory(product: any, twoStepSaleEnabled?: boolean) {
    if (!product) return product;
    const { recipeComponents: rawComponents, reservedStock: _rStock, ...rest } = product;
    const isRecipe = Boolean(product.isRecipe);
    const components = rawComponents
      ? rawComponents.map((c: any) => ({
          productId: c.componentProductId || c.productId,
          quantity: Number(c.quantity),
          ...(c.componentProduct
            ? {
                productName: c.componentProduct.name,
                unit: c.componentProduct.unit || 'UND',
                currentStock: Number(c.componentProduct.stock),
              }
            : {}),
        }))
      : undefined;

    const stock = product.stock != null ? Number(product.stock) : 0;
    const mapped: any = {
      ...rest,
      stock,
      minStock: product.minStock != null ? Number(product.minStock) : 0,
      maxStock: product.maxStock != null ? Number(product.maxStock) : null,
      unit: product.unit || 'UND',
      trackInventory: product.trackStock,
      isRecipe,
      ...(isRecipe && components ? { components } : {}),
    };

    if (twoStepSaleEnabled) {
      const reserved = product.reservedStock != null ? Number(product.reservedStock) : 0;
      mapped.reservedStock = reserved;
      mapped.availableStock = Math.max(0, stock - reserved);
    }

    return mapped;
  }

  private filterActiveAttributes(
    product: any,
    activeKeys: Set<string>,
    userRole?: string,
    wholesaleEnabled?: boolean,
    twoStepSaleEnabled?: boolean,
  ) {
    if (!product) return product;
    const rawAttrs =
      product.attributes && typeof product.attributes === 'object' && !Array.isArray(product.attributes)
        ? product.attributes
        : {};

    const filteredAttrs: Record<string, any> = {};
    for (const key of activeKeys) {
      if (rawAttrs[key] !== undefined) {
        filteredAttrs[key] = rawAttrs[key];
      }
      if (rawAttrs[`${key}_id`] !== undefined) {
        filteredAttrs[`${key}_id`] = rawAttrs[`${key}_id`];
      }
    }

    const wholesale_price = product.wholesalePrice != null ? Number(product.wholesalePrice) : null;
    const wholesale_min_qty = product.wholesaleMinQty != null ? Number(product.wholesaleMinQty) : null;
    const isWholesaleEnabled = wholesaleEnabled !== undefined
      ? Boolean(wholesaleEnabled)
      : product.business?.wholesaleEnabled !== undefined
      ? Boolean(product.business.wholesaleEnabled)
      : false;

    const isTwoStepEnabled = twoStepSaleEnabled !== undefined
      ? Boolean(twoStepSaleEnabled)
      : product.business?.twoStepSaleEnabled !== undefined
      ? Boolean(product.business.twoStepSaleEnabled)
      : false;

    const mapped = {
      ...this.mapProductWithInventory(product, isTwoStepEnabled),
      attributes: filteredAttrs,
      wholesalePrice: wholesale_price,
      wholesaleMinQty: wholesale_min_qty,
      wholesale_price,
      wholesale_min_qty,
      wholesale_enabled: isWholesaleEnabled,
      wholesaleEnabled: isWholesaleEnabled,
    };

    if (userRole === UserRole.CAJERO || userRole === UserRole.WAITER || userRole === UserRole.VENDEDOR) {
      delete mapped.cost;
    }

    if (userRole === UserRole.VENDEDOR) {
      delete mapped.markupPct;
      delete mapped.supplierId;
      delete mapped.supplier;
      delete mapped.purchasePrice;
      delete mapped.purchaseCost;
      delete mapped.costHistories;
    }

    return mapped;
  }

  private async validateAttributes(
    businessId: string,
    incomingAttributes: Record<string, any> | undefined,
    existingAttributes?: Record<string, any>,
  ): Promise<Record<string, any>> {
    if (incomingAttributes === undefined) {
      return existingAttributes || {};
    }

    if (typeof incomingAttributes !== 'object' || incomingAttributes === null || Array.isArray(incomingAttributes)) {
      throw new UnprocessableEntityException('El campo "attributes" debe ser un objeto');
    }

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      include: {
        fieldOptions: true,
      },
    });
    const inactiveFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: false },
    });

    const activeMap = new Map(activeFields.map((f) => [f.key, f]));
    const inactiveMap = new Map(inactiveFields.map((f) => [f.key, f]));

    // Para campos LIST con allowCreateInline, crear opciones nuevas si no existen
    for (const [key, val] of Object.entries(incomingAttributes)) {
      const field: any = activeMap.get(key);
      if (!field || field.dataType !== ProductFieldDataType.LIST) continue;
      if (val === null || val === undefined || val === '') continue;

      let rawStr = '';
      if (typeof val === 'string') {
        rawStr = val.trim();
      } else if (typeof val === 'object' && val !== null) {
        rawStr = String(val.label || val.id || '').trim();
      }
      if (!rawStr) continue;

      const norm = normalizeOptionLabel(rawStr);
      const options: any[] = field.fieldOptions || [];
      let matched = options.find(
        (o) => o.id === rawStr || o.normalizedLabel === norm || o.label.toLowerCase() === rawStr.toLowerCase(),
      );

      if (!matched && (field.allowCreateInline ?? true)) {
        const last = await this.prisma.productFieldOption.findFirst({
          where: { businessId, fieldDefinitionId: field.id },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        const nextOrder = (last?.sortOrder ?? -1) + 1;

        const newOpt = await this.prisma.productFieldOption.create({
          data: {
            businessId,
            fieldDefinitionId: field.id,
            label: rawStr,
            normalizedLabel: norm,
            sortOrder: nextOrder,
            isActive: true,
          },
        });
        field.fieldOptions = field.fieldOptions || [];
        field.fieldOptions.push(newOpt);
      }
    }

    return this.validateAttributesSync(incomingAttributes, existingAttributes, activeMap, inactiveMap);
  }

  public validateAttributesSync(
    incomingAttributes: Record<string, any>,
    existingAttributes: Record<string, any> | undefined,
    activeMap: Map<string, any>,
    inactiveMap: Map<string, any>,
  ): Record<string, any> {
    // 1. Claves desconocidas
    for (const key of Object.keys(incomingAttributes)) {
      if (!activeMap.has(key)) {
        // Permitir claves terminadas en _id si corresponden a un campo LIST activo
        if (key.endsWith('_id')) {
          const baseKey = key.replace(/_id$/, '');
          const baseField = activeMap.get(baseKey);
          if (baseField && baseField.dataType === ProductFieldDataType.LIST) {
            continue;
          }
          throw new UnprocessableEntityException('El sufijo _id está reservado');
        }
        if (inactiveMap.has(key)) {
          const existingVal = existingAttributes ? existingAttributes[key] : undefined;
          const incomingVal = incomingAttributes[key];
          if (incomingVal !== existingVal) {
            throw new UnprocessableEntityException(
              `El campo '${inactiveMap.get(key)!.label}' (${key}) está desactivado y no puede ser modificado`,
            );
          }
        } else {
          throw new UnprocessableEntityException(
            `Clave de atributo desconocida: '${key}'. No corresponde a ningún campo dinámico activo del negocio`,
          );
        }
      }
    }

    // 2. Campos requeridos (solo para campos activos)
    for (const field of activeMap.values()) {
      if (field.required) {
        const value =
          incomingAttributes[field.key] !== undefined
            ? incomingAttributes[field.key]
            : (existingAttributes ? existingAttributes[field.key] : undefined);

        if (value === undefined || value === null || value === '') {
          throw new UnprocessableEntityException(
            `El campo requerido '${field.label}' (${field.key}) es obligatorio`,
          );
        }
      }
    }

    // 3. Validar tipos de datos y opciones de SELECT y LIST
    for (const [key, val] of Object.entries(incomingAttributes)) {
      const field: any = activeMap.get(key);
      if (!field) continue;

      if (val === null || val === undefined || val === '') {
        continue;
      }

      switch (field.dataType) {
        case ProductFieldDataType.TEXT:
          if (typeof val !== 'string') {
            throw new UnprocessableEntityException(
              `El valor para el campo '${field.label}' (${key}) debe ser una cadena de texto`,
            );
          }
          break;

        case ProductFieldDataType.NUMBER: {
          const num = typeof val === 'number' ? val : Number(val);
          if (isNaN(num) || typeof val === 'boolean') {
            throw new UnprocessableEntityException(
              `El valor para el campo '${field.label}' (${key}) debe ser un número válido`,
            );
          }
          break;
        }

        case ProductFieldDataType.SELECT: {
          const options = (field.options as string[]) || [];
          if (!options.includes(String(val))) {
            throw new UnprocessableEntityException(
              `Opción inválida '${val}' para el campo '${field.label}'. Opciones permitidas: ${options.join(', ')}`,
            );
          }
          break;
        }

        case ProductFieldDataType.LIST: {
          let rawStr = '';
          if (typeof val === 'string') {
            rawStr = val.trim();
          } else if (typeof val === 'object' && val !== null) {
            rawStr = String(val.label || val.id || '').trim();
          } else {
            throw new UnprocessableEntityException(
              `El valor para el campo '${field.label}' (${key}) debe ser una cadena de texto o ID de opción`,
            );
          }

          if (!rawStr) break;

          const norm = normalizeOptionLabel(rawStr);
          const options: any[] = field.fieldOptions || [];
          const matched = options.find(
            (o) => o.id === rawStr || o.normalizedLabel === norm || o.label.toLowerCase() === rawStr.toLowerCase(),
          );

          if (matched) {
            if (!matched.isActive) {
              const existingLabel = existingAttributes ? existingAttributes[key] : undefined;
              const existingId = existingAttributes ? existingAttributes[`${key}_id`] : undefined;
              const alreadyHad = existingId === matched.id || existingLabel === matched.label;
              if (!alreadyHad) {
                throw new UnprocessableEntityException(
                  `La opción '${matched.label}' para el campo '${field.label}' está desactivada y no puede asignarse a nuevos productos`,
                );
              }
            }
            incomingAttributes[key] = matched.label;
            incomingAttributes[`${key}_id`] = matched.id;
          } else {
            if (!(field.allowCreateInline ?? true)) {
              throw new UnprocessableEntityException(
                `La opción '${rawStr}' no existe para el campo '${field.label}' y no está permitida la creación al vuelo`,
              );
            }
            incomingAttributes[key] = rawStr;
          }
          break;
        }

        case ProductFieldDataType.BOOLEAN:
          if (typeof val !== 'boolean') {
            throw new UnprocessableEntityException(
              `El valor para el campo '${field.label}' (${key}) debe ser un valor booleano (true o false)`,
            );
          }
          break;

        case ProductFieldDataType.DATE: {
          const d = new Date(val);
          if (isNaN(d.getTime())) {
            throw new UnprocessableEntityException(
              `El valor para el campo '${field.label}' (${key}) debe ser una fecha válida`,
            );
          }
          break;
        }
      }
    }

    const merged = { ...(existingAttributes || {}) };
    for (const [k, v] of Object.entries(incomingAttributes)) {
      if (activeMap.has(k) || (k.endsWith('_id') && activeMap.has(k.replace(/_id$/, '')))) {
        merged[k] = v;
      }
    }
    return merged;
  }

  async findAll(
    businessId: string,
    filters?: {
      search?: string;
      categoryId?: string;
      lowStock?: boolean;
      isActive?: boolean;
      taxable?: boolean;
      type?: string;
      expiry?: string;
      expiryMonth?: string;
      sort?: string;
    },
    userRole?: string,
  ) {
    const where: any = { businessId };

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    } else {
      where.isActive = true;
    }

    if (filters?.categoryId) where.categoryId = filters.categoryId;
    if (filters?.taxable !== undefined) where.taxable = filters.taxable;
    if (filters?.type) where.type = filters.type;

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true, searchable: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));
    const searchableKeys = activeFields.filter((f) => f.searchable).map((f) => f.key);

    if (filters?.search) {
      let matchingIds: string[] = [];
      if (searchableKeys.length > 0) {
        const orSql = searchableKeys.map((k) => `"attributes"->>'${k}' ILIKE $2`).join(' OR ');
        const matches: any[] = await this.prisma.$queryRawUnsafe(
          `SELECT id FROM "pos_products" WHERE "businessId" = $1 AND (${orSql})`,
          businessId,
          `%${filters.search}%`,
        );
        matchingIds = matches.map((m) => m.id);
      }

      where.OR = [
        { name: { contains: filters.search, mode: "insensitive" } },
        { barcode: { contains: filters.search, mode: "insensitive" } },
        { sku: { contains: filters.search, mode: "insensitive" } },
        ...(matchingIds.length > 0 ? [{ id: { in: matchingIds } }] : []),
      ];
    }

    const [products, business] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: true,
          supplier: { select: { id: true, name: true } },
          recipeComponents: {
            include: {
              componentProduct: { select: { id: true, name: true, unit: true, stock: true } },
            },
          },
        },
        orderBy: { name: "asc" },
      }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { wholesaleEnabled: true, tracksBatches: true, twoStepSaleEnabled: true },
      }),
    ]);

    // 210a: Agregado de lotes por producto (una sola consulta, solo si el negocio tiene tracksBatches = true)
    let batchMap = new Map<string, {
      activeBatchCount: number;
      hasBatchWithoutDate: boolean;
      nextExpiryDate: string | null;
      nextExpiryBatchCode: string | null;
      expiredQty: number;
      hasExpired: boolean;
      hasDays30: boolean;
      hasDays31_60: boolean;
      hasDays61_90: boolean;
      expiryMonths: string[];
    }>();

    if (business?.tracksBatches) {
      const batchAggs: any[] = await this.prisma.$queryRaw`
        SELECT
          b."productId",
          COUNT(*)::int AS "activeBatchCount",
          BOOL_OR(b."expiryDate" IS NULL) AS "hasBatchWithoutDate",
          MIN(b."expiryDate") AS "nextExpiryDate",
          (ARRAY_AGG(b."batchNumber" ORDER BY b."expiryDate" ASC, b."createdAt" ASC) FILTER (WHERE b."expiryDate" IS NOT NULL))[1] AS "nextExpiryBatchCode",
          COALESCE(SUM(CASE WHEN b."expiryDate" < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date THEN b.quantity ELSE 0 END), 0)::float AS "expiredQty",
          BOOL_OR(b."expiryDate" < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date) AS "hasExpired",
          BOOL_OR(b."expiryDate" >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date AND b."expiryDate" <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date + 30) AS "hasDays30",
          BOOL_OR(b."expiryDate" > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date + 30 AND b."expiryDate" <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date + 60) AS "hasDays31_60",
          BOOL_OR(b."expiryDate" > (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date + 60 AND b."expiryDate" <= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date + 90) AS "hasDays61_90",
          ARRAY_AGG(DISTINCT to_char(b."expiryDate", 'YYYY-MM')) FILTER (WHERE b."expiryDate" IS NOT NULL) AS "expiryMonths"
        FROM pos_product_batches b
        WHERE b."businessId" = ${businessId} AND b.quantity > 0
        GROUP BY b."productId";
      `;

      for (const row of batchAggs) {
        batchMap.set(row.productId, {
          activeBatchCount: Number(row.activeBatchCount || 0),
          hasBatchWithoutDate: Boolean(row.hasBatchWithoutDate),
          nextExpiryDate: row.nextExpiryDate ? new Date(row.nextExpiryDate).toISOString().split('T')[0] : null,
          nextExpiryBatchCode: row.nextExpiryBatchCode || null,
          expiredQty: Number(row.expiredQty || 0),
          hasExpired: Boolean(row.hasExpired),
          hasDays30: Boolean(row.hasDays30),
          hasDays31_60: Boolean(row.hasDays31_60),
          hasDays61_90: Boolean(row.hasDays61_90),
          expiryMonths: Array.isArray(row.expiryMonths) ? row.expiryMonths : [],
        });
      }
    }

    const todayStr = formatDateInTimezone(new Date(), 'America/Managua');
    const todayMs = new Date(todayStr + 'T00:00:00.000Z').getTime();

    let mapped = products.map((p) => {
      const item = this.filterActiveAttributes(p, activeKeys, userRole, business?.wholesaleEnabled, business?.twoStepSaleEnabled);
      if (business?.tracksBatches) {
        const b = batchMap.get(p.id);
        item.nextExpiryDate = b?.nextExpiryDate ?? null;
        item.nextExpiryBatchCode = b?.nextExpiryBatchCode ?? null;
        item.activeBatchCount = b?.activeBatchCount ?? 0;
        item.expiredQty = b?.expiredQty ?? 0;
        item.hasBatchWithoutDate = b?.hasBatchWithoutDate ?? false;
      }
      return item;
    });

    if (filters?.lowStock) {
      mapped = mapped.filter((p) => p.trackStock && Number(p.stock) <= Number(p.minStock));
    }

    // Filtros de vencimiento solo si el negocio tiene tracksBatches activo
    if (business?.tracksBatches) {
      if (filters?.expiry) {
        mapped = mapped.filter((p) => {
          const b = batchMap.get(p.id);
          const nextExp = p.nextExpiryDate;
          let daysRemaining: number | null = null;
          if (nextExp) {
            const expMs = new Date(nextExp + 'T00:00:00.000Z').getTime();
            daysRemaining = Math.ceil((expMs - todayMs) / (1000 * 60 * 60 * 24));
          }

          switch (filters.expiry) {
            case 'EXPIRED':
              return p.expiredQty > 0 || (b ? b.hasExpired : false) || (daysRemaining !== null && daysRemaining < 0);
            case 'DAYS_30':
              return (b ? b.hasDays30 : false) || (daysRemaining !== null && daysRemaining >= 0 && daysRemaining <= 30);
            case 'DAYS_31_60':
              return (b ? b.hasDays31_60 : false) || (daysRemaining !== null && daysRemaining >= 31 && daysRemaining <= 60);
            case 'DAYS_61_90':
              return (b ? b.hasDays61_90 : false) || (daysRemaining !== null && daysRemaining >= 61 && daysRemaining <= 90);
            case 'NO_DATE':
              return p.hasBatchWithoutDate === true || (p.activeBatchCount > 0 && p.nextExpiryDate === null);
            case 'NO_BATCHES':
              return p.activeBatchCount === 0;
            default:
              return true;
          }
        });
      }

      if (filters?.expiryMonth) {
        mapped = mapped.filter((p) => {
          const b = batchMap.get(p.id);
          return b ? b.expiryMonths.includes(filters.expiryMonth!) : false;
        });
      }

      if (filters?.sort === 'nextExpiry') {
        mapped.sort((a, b) => {
          const aDate = a.nextExpiryDate ? new Date(a.nextExpiryDate + 'T00:00:00.000Z').getTime() : null;
          const bDate = b.nextExpiryDate ? new Date(b.nextExpiryDate + 'T00:00:00.000Z').getTime() : null;

          if (aDate !== null && bDate !== null) {
            if (aDate !== bDate) return aDate - bDate;
            return a.name.localeCompare(b.name);
          }
          if (aDate !== null && bDate === null) return -1;
          if (aDate === null && bDate !== null) return 1;
          return a.name.localeCompare(b.name);
        });
      }
    }

    return mapped;
  }

  async findOne(id: string, businessId: string, userRole?: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, businessId },
      include: {
        category: true,
        supplier: true,
        recipeComponents: {
          include: {
            componentProduct: { select: { id: true, name: true, unit: true, stock: true } },
          },
        },
      },
    });
    if (!product) throw new NotFoundException("Producto no encontrado");

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { wholesaleEnabled: true, tracksBatches: true, twoStepSaleEnabled: true },
    });

    const item = this.filterActiveAttributes(product, activeKeys, userRole, business?.wholesaleEnabled, business?.twoStepSaleEnabled);

    if (business?.tracksBatches) {
      const batchAggs: any[] = await this.prisma.$queryRaw`
        SELECT
          COUNT(*)::int AS "activeBatchCount",
          BOOL_OR(b."expiryDate" IS NULL) AS "hasBatchWithoutDate",
          MIN(b."expiryDate") AS "nextExpiryDate",
          (ARRAY_AGG(b."batchNumber" ORDER BY b."expiryDate" ASC, b."createdAt" ASC) FILTER (WHERE b."expiryDate" IS NOT NULL))[1] AS "nextExpiryBatchCode",
          COALESCE(SUM(CASE WHEN b."expiryDate" < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Managua')::date THEN b.quantity ELSE 0 END), 0)::float AS "expiredQty"
        FROM pos_product_batches b
        WHERE b."businessId" = ${businessId} AND b."productId" = ${id} AND b.quantity > 0;
      `;
      const row = batchAggs[0];
      item.nextExpiryDate = row?.nextExpiryDate ? new Date(row.nextExpiryDate).toISOString().split('T')[0] : null;
      item.nextExpiryBatchCode = row?.nextExpiryBatchCode || null;
      item.activeBatchCount = Number(row?.activeBatchCount || 0);
      item.expiredQty = Number(row?.expiredQty || 0);
      item.hasBatchWithoutDate = Boolean(row?.hasBatchWithoutDate);
    }

    return item;
  }

  async findByBarcode(businessId: string, barcode: string, userRole?: string) {
    this.logger.log(`[findByBarcode] barcode=${barcode} businessId=${businessId}`);
    const product = await this.prisma.product.findFirst({
      where: { businessId, barcode, isActive: true },
      include: {
        category: true,
        recipeComponents: {
          include: {
            componentProduct: { select: { id: true, name: true, unit: true, stock: true } },
          },
        },
      },
    });
    if (!product) throw new NotFoundException("Producto no encontrado");

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { wholesaleEnabled: true, twoStepSaleEnabled: true },
    });

    return this.filterActiveAttributes(product, activeKeys, userRole, business?.wholesaleEnabled, business?.twoStepSaleEnabled);
  }

  async create(dto: CreateProductDto, businessId: string, userId?: string) {
    this.logger.log(`[create] producto="${dto.name}" businessId=${businessId}`);

    if (dto.barcode) {
      const existing = await this.prisma.product.findFirst({
        where: { businessId, barcode: dto.barcode },
      });
      if (existing) {
        this.logger.warn(`[create] barcode duplicado: ${dto.barcode} businessId=${businessId}`);
        throw new ConflictException(`El código de barras "${dto.barcode}" ya está registrado`);
      }
    }

    if (dto.sku) {
      const existing = await this.prisma.product.findFirst({
        where: { businessId, sku: dto.sku },
      });
      if (existing) throw new ConflictException(`El SKU "${dto.sku}" ya está registrado`);
    }

    if (!dto.categoryId) {
      throw new BadRequestException("La categoría es obligatoria");
    }

    const category = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, businessId, isActive: true },
    });
    if (!category) {
      throw new BadRequestException("La categoría especificada no existe o no pertenece a este negocio");
    }

    let trackStock = dto.trackStock ?? dto.trackInventory;
    // 160d: tipo explícito; si no viene, PRODUCT (compatibilidad con desktop viejo)
    const type: 'PRODUCT' | 'SERVICE' = dto.type ?? 'PRODUCT';
    if (type === 'SERVICE') {
      trackStock = false;
    }
    if (trackStock === undefined) {
      const subscription = await this.prisma.businessProductSubscription.findUnique({
        where: { businessId_productType: { businessId, productType: BusinessProductType.POS } },
        select: { posVertical: true },
      });
      const business = await this.prisma.business.findUnique({
        where: { id: businessId },
        select: { posVertical: true },
      });
      const vertical = subscription?.posVertical || business?.posVertical || PosVertical.RETAIL;
      trackStock = vertical === PosVertical.RESTAURANTE ? false : true;
    }

    const validatedAttributes = await this.validateAttributes(businessId, dto.attributes);

    const unit = (dto.unit || 'UND').trim().toUpperCase();
    if (dto.stock !== undefined && dto.stock !== null) {
      dto.stock = validateProductQuantity(unit, dto.stock, dto.name);
    }
    if (dto.minStock !== undefined && dto.minStock !== null) {
      dto.minStock = validateProductQuantity(unit, dto.minStock, dto.name);
    }
    if (dto.maxStock !== undefined && dto.maxStock !== null) {
      dto.maxStock = validateProductQuantity(unit, dto.maxStock, dto.name);
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { wholesaleEnabled: true },
    });

    const rawWholesalePrice = dto.wholesalePrice !== undefined ? dto.wholesalePrice : dto.wholesale_price;
    const rawWholesaleMinQty = dto.wholesaleMinQty !== undefined ? dto.wholesaleMinQty : dto.wholesale_min_qty;

    if (rawWholesalePrice !== undefined || rawWholesaleMinQty !== undefined) {
      if (rawWholesalePrice != null && rawWholesaleMinQty == null) {
        throw new BadRequestException('Si se especifica precio por mayor, la cantidad mínima es obligatoria');
      }
      if (rawWholesaleMinQty != null && rawWholesalePrice == null) {
        throw new BadRequestException('Si se especifica cantidad mínima por mayor, el precio por mayor es obligatorio');
      }
      if (rawWholesalePrice != null && rawWholesaleMinQty != null) {
        if (!business?.wholesaleEnabled) {
          throw new BadRequestException('La venta por mayor no está habilitada en este negocio');
        }
        if (rawWholesalePrice <= 0) {
          throw new BadRequestException('El precio por mayor debe ser mayor a 0');
        }
        if (rawWholesaleMinQty < 2) {
          throw new BadRequestException('La cantidad mínima para precio por mayor debe ser mayor o igual a 2');
        }
        if (rawWholesalePrice >= dto.price) {
          throw new BadRequestException('El precio por mayor debe ser menor que el precio normal');
        }
      }
    }

    const {
      trackInventory,
      attributes: _ignored,
      wholesale_price: _wp,
      wholesale_min_qty: _wmq,
      initialLotNumber,
      initialExpiryDate,
      ...productData
    } = dto as any;

    const product = await this.prisma.product.create({
      data: {
        ...productData,
        wholesalePrice: rawWholesalePrice != null ? new Prisma.Decimal(rawWholesalePrice) : null,
        wholesaleMinQty: rawWholesaleMinQty != null ? new Prisma.Decimal(rawWholesaleMinQty) : null,
        unit,
        type,
        trackStock,
        attributes: validatedAttributes,
        businessId,
      },
      include: { category: true, supplier: { select: { id: true, name: true } } },
    });

    const initialStock = Number(product.stock);
    let initialBatchId: string | null = null;

    if (product.trackStock && initialStock > 0) {
      if (dto.tracksBatches) {
        const customBatch = dto.initialLotNumber
          ? {
              batchNumber: dto.initialLotNumber.trim(),
              expiryDate: dto.initialExpiryDate ? new Date(dto.initialExpiryDate) : null,
            }
          : undefined;

        const batch = await this.batchesService.ensureInitialBatch(
          this.prisma,
          businessId,
          product.id,
          initialStock,
          product.cost != null ? Number(product.cost) : null,
          customBatch,
        );
        if (batch) {
          initialBatchId = batch.id;
        }
      }

      let resolvedUserId = userId;
      if (!resolvedUserId || resolvedUserId === 'system') {
        const fallbackUser = await this.prisma.user.findFirst({
          where: { businessId },
          select: { id: true },
        });
        resolvedUserId = fallbackUser?.id;
      }

      if (resolvedUserId) {
        await this.prisma.stockMovement.create({
          data: {
            businessId,
            productId: product.id,
            userId: resolvedUserId,
            type: StockMovementType.INITIAL,
            quantity: initialStock,
            stockBefore: 0,
            stockAfter: initialStock,
            cost: product.cost != null ? new Prisma.Decimal(product.cost.toString()) : null,
            concept: 'Stock inicial',
            batchId: initialBatchId,
          },
        });
      }
    }

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    return this.filterActiveAttributes(product, activeKeys, undefined, business?.wholesaleEnabled);
  }

  async update(id: string, dto: UpdateProductDto, businessId: string, userId?: string) {
    const product = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!product) throw new NotFoundException("Producto no encontrado");

    if (dto.barcode && dto.barcode !== product.barcode) {
      const existing = await this.prisma.product.findFirst({
        where: { businessId, barcode: dto.barcode, NOT: { id } },
      });
      if (existing) throw new ConflictException(`El código de barras "${dto.barcode}" ya está registrado`);
    }

    if (dto.categoryId !== undefined) {
      if (!dto.categoryId) {
        throw new BadRequestException("La categoría no puede estar vacía");
      }
      const category = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, businessId, isActive: true },
      });
      if (!category) {
        throw new BadRequestException("La categoría especificada no existe o no pertenece a este negocio");
      }
    }

    let trackStock = dto.trackStock ?? dto.trackInventory;
    // 160d: si no viene type se mantiene el actual. Un SERVICE nunca controla stock propio.
    const effectiveType = dto.type ?? (product as any).type ?? 'PRODUCT';
    if (effectiveType === 'SERVICE') {
      trackStock = false;
    }
    if (product.isRecipe && trackStock === true) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'RECIPE_PARENT_TRACKS_STOCK',
        message: 'Un producto con receta no puede controlar inventario (trackStock debe ser false)',
      });
    }

    if (trackStock === false) {
      const usedInRecipe = await this.prisma.productComponent.findFirst({
        where: { componentProductId: id, businessId },
        include: { parentProduct: { select: { name: true } } },
      });
      if (usedInRecipe) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'RECIPE_COMPONENT_NOT_STOCKED',
          message: `El producto es componente del servicio "${usedInRecipe.parentProduct?.name}" y debe controlar inventario (trackStock = true)`,
        });
      }
    }

    if (dto.tracksBatches !== undefined) {
      if (dto.tracksBatches === true && !product.tracksBatches) {
        const currentStock = Number(product.stock);
        if (currentStock > 0) {
          await this.batchesService.ensureInitialBatch(
            this.prisma,
            businessId,
            product.id,
            currentStock,
            product.cost != null ? Number(product.cost) : null,
          );
        }
      } else if (dto.tracksBatches === false && product.tracksBatches) {
        const activeBatchesCount = await this.prisma.productBatch.count({
          where: { businessId, productId: product.id, quantity: { gt: 0 } },
        });
        if (activeBatchesCount > 0 && dto.confirm !== true) {
          throw new BadRequestException(
            'El producto tiene lotes con stock activo. Para desactivar el control de lotes envíe confirm: true',
          );
        }
      }
    }

    const { trackInventory, attributes: incomingAttributes, wholesale_price: _wp, wholesale_min_qty: _wmq, confirm: _confirm, ...updateData } = dto as any;
    if (trackStock !== undefined) {
      (updateData as any).trackStock = trackStock;
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { wholesaleEnabled: true },
    });

    const rawWholesalePrice = dto.wholesalePrice !== undefined ? dto.wholesalePrice : dto.wholesale_price;
    const rawWholesaleMinQty = dto.wholesaleMinQty !== undefined ? dto.wholesaleMinQty : dto.wholesale_min_qty;

    let targetWholesalePrice = product.wholesalePrice != null ? Number(product.wholesalePrice) : null;
    let targetWholesaleMinQty = product.wholesaleMinQty != null ? Number(product.wholesaleMinQty) : null;
    if (rawWholesalePrice !== undefined) targetWholesalePrice = rawWholesalePrice;
    if (rawWholesaleMinQty !== undefined) targetWholesaleMinQty = rawWholesaleMinQty;

    if (rawWholesalePrice !== undefined || rawWholesaleMinQty !== undefined) {
      if (targetWholesalePrice === null && targetWholesaleMinQty === null) {
        (updateData as any).wholesalePrice = null;
        (updateData as any).wholesaleMinQty = null;
      } else if (targetWholesalePrice != null && targetWholesaleMinQty == null) {
        throw new BadRequestException('Si se especifica precio por mayor, la cantidad mínima es obligatoria');
      } else if (targetWholesaleMinQty != null && targetWholesalePrice == null) {
        throw new BadRequestException('Si se especifica cantidad mínima por mayor, el precio por mayor es obligatorio');
      } else if (targetWholesalePrice != null && targetWholesaleMinQty != null) {
        if (!business?.wholesaleEnabled) {
          throw new BadRequestException('La venta por mayor no está habilitada en este negocio');
        }
        if (targetWholesalePrice <= 0) {
          throw new BadRequestException('El precio por mayor debe ser mayor a 0');
        }
        if (targetWholesaleMinQty < 2) {
          throw new BadRequestException('La cantidad mínima para precio por mayor debe ser mayor o igual a 2');
        }
        const effectivePrice = dto.price !== undefined ? dto.price : product.price;
        if (targetWholesalePrice >= effectivePrice) {
          throw new BadRequestException('El precio por mayor debe ser menor que el precio normal');
        }
        (updateData as any).wholesalePrice = new Prisma.Decimal(targetWholesalePrice);
        (updateData as any).wholesaleMinQty = new Prisma.Decimal(targetWholesaleMinQty);
      }
    }

    const effectiveUnit = (dto.unit || product.unit || 'UND').trim().toUpperCase();
    if (dto.unit !== undefined) {
      (updateData as any).unit = effectiveUnit;
    }
    if (dto.stock !== undefined && dto.stock !== null) {
      dto.stock = validateProductQuantity(effectiveUnit, dto.stock, dto.name || product.name);
      (updateData as any).stock = dto.stock;
    }
    if (dto.minStock !== undefined && dto.minStock !== null) {
      dto.minStock = validateProductQuantity(effectiveUnit, dto.minStock, dto.name || product.name);
      (updateData as any).minStock = dto.minStock;
    }
    if (dto.maxStock !== undefined && dto.maxStock !== null) {
      dto.maxStock = validateProductQuantity(effectiveUnit, dto.maxStock, dto.name || product.name);
      (updateData as any).maxStock = dto.maxStock;
    }

    if (incomingAttributes !== undefined) {
      const existingAttrs =
        product.attributes && typeof product.attributes === 'object' && !Array.isArray(product.attributes)
          ? (product.attributes as Record<string, any>)
          : {};

      const validatedAttributes = await this.validateAttributes(
        businessId,
        incomingAttributes,
        existingAttrs,
      );
      (updateData as any).attributes = validatedAttributes;
    }

    this.logger.log(`[update] id=${id} businessId=${businessId}`);
    const updated = await this.prisma.product.update({
      where: { id },
      data: updateData,
      include: { category: true, supplier: { select: { id: true, name: true } } },
    });

    const currentStock = Number(product.stock);
    if (dto.stock !== undefined && dto.stock !== currentStock && (trackStock ?? product.trackStock)) {
      const stockDiff = round3(dto.stock - currentStock);
      await this.prisma.stockMovement.create({
        data: {
          businessId,
          productId: product.id,
          userId: userId || 'system',
          type: StockMovementType.AJUSTE,
          quantity: stockDiff,
          stockBefore: currentStock,
          stockAfter: dto.stock,
          cost: product.cost != null ? new Prisma.Decimal(product.cost.toString()) : null,
          concept: 'Edición manual de producto',
        },
      });
    }

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    return this.filterActiveAttributes(updated, activeKeys, undefined, business?.wholesaleEnabled);
  }

  async remove(id: string, businessId: string) {
    const product = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!product) throw new NotFoundException("Producto no encontrado");
    const removed = await this.prisma.product.update({ where: { id }, data: { isActive: false } });
    return this.mapProductWithInventory(removed);
  }

  async bulkUpdate(
    businessId: string,
    dto: BulkUpdateProductsDto,
    user: JwtPayload,
  ) {
    if (
      dto.productIds !== 'ALL_FILTERED' &&
      (!Array.isArray(dto.productIds) || dto.productIds.length === 0)
    ) {
      throw new BadRequestException('productIds debe ser un arreglo no vacío de IDs o "ALL_FILTERED"');
    }

    if (
      !dto.changes ||
      (dto.changes.taxable === undefined && dto.changes.markupPct === undefined)
    ) {
      throw new BadRequestException('Debe proporcionar al menos un cambio (taxable o markupPct)');
    }

    if (Array.isArray(dto.productIds) && dto.productIds.length > 1000) {
      throw new BadRequestException('El límite máximo por llamada es de 1,000 productos');
    }

    const dataToUpdate: Prisma.ProductUpdateManyMutationInput = {
      updatedAt: new Date(),
    };

    if (dto.changes.taxable !== undefined) {
      dataToUpdate.taxable = Boolean(dto.changes.taxable);
    }

    if (dto.changes.markupPct !== undefined) {
      dataToUpdate.markupPct = dto.changes.markupPct !== null ? Number(dto.changes.markupPct) : null;
    }

    return this.prisma.$transaction(async (tx) => {
      let where: Prisma.ProductWhereInput = { businessId };

      if (Array.isArray(dto.productIds)) {
        where.id = { in: dto.productIds };
      } else {
        // "ALL_FILTERED"
        if (dto.filters?.categoryId) {
          where.categoryId = dto.filters.categoryId;
        }
        if (dto.filters?.taxable !== undefined) {
          where.taxable = dto.filters.taxable;
        }
        if (dto.filters?.isActive !== undefined) {
          where.isActive = dto.filters.isActive;
        } else {
          where.isActive = true;
        }

        if (dto.filters?.search) {
          const activeFields = await tx.productFieldDefinition.findMany({
            where: { businessId, isActive: true },
            select: { key: true, searchable: true },
          });
          const searchableKeys = activeFields.filter((f) => f.searchable).map((f) => f.key);
          let matchingIds: string[] = [];
          if (searchableKeys.length > 0) {
            const orSql = searchableKeys.map((k) => `"attributes"->>'${k}' ILIKE $2`).join(' OR ');
            const matches: any[] = await tx.$queryRawUnsafe(
              `SELECT id FROM "pos_products" WHERE "businessId" = $1 AND (${orSql})`,
              businessId,
              `%${dto.filters.search}%`,
            );
            matchingIds = matches.map((m) => m.id);
          }

          where.OR = [
            { name: { contains: dto.filters.search, mode: 'insensitive' } },
            { barcode: { contains: dto.filters.search, mode: 'insensitive' } },
            { sku: { contains: dto.filters.search, mode: 'insensitive' } },
            ...(matchingIds.length > 0 ? [{ id: { in: matchingIds } }] : []),
          ];
        }
      }

      // Validar tope de 1,000 productos
      const matched = await tx.product.findMany({
        where,
        select: { id: true },
        take: 1001,
      });

      if (matched.length > 1000) {
        throw new BadRequestException(
          'La selección excede el límite máximo de 1,000 productos por llamada. Por favor refine los filtros.',
        );
      }

      const idsToUpdate = matched.map((p) => p.id);

      if (idsToUpdate.length === 0) {
        return {
          success: true,
          updatedCount: 0,
          changes: dto.changes,
          message: 'No se encontraron productos que coincidan con los criterios.',
        };
      }

      const updateRes = await tx.product.updateMany({
        where: { id: { in: idsToUpdate }, businessId },
        data: dataToUpdate,
      });

      // Registro en auditoría
      await tx.posAuditLog.create({
        data: {
          businessId,
          userId: user.sub,
          userRole: user.role,
          action: 'PRODUCTOS_CAMBIO_MASIVO',
          entityType: 'Product',
          entityId: idsToUpdate.length === 1 ? idsToUpdate[0] : 'BULK',
          reason: `Actualización masiva de ${updateRes.count} producto(s)`,
          after: {
            count: updateRes.count,
            changes: dto.changes as any,
            selectionType: Array.isArray(dto.productIds) ? 'LIST' : 'ALL_FILTERED',
            filters: (dto.filters || null) as any,
            productIdsSample: idsToUpdate.slice(0, 50),
          },
        },
      });

      this.logger.log(
        `[bulkUpdate] businessId=${businessId} userId=${user.sub} updated=${updateRes.count} changes=${JSON.stringify(dto.changes)}`,
      );

      return {
        success: true,
        updatedCount: updateRes.count,
        changes: dto.changes,
        message: `Se actualizaron ${updateRes.count} producto(s) correctamente`,
      };
    });
  }

  async adjustStock(productId: string, dto: AdjustStockDto, userId: string, businessId: string) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId, businessId } });
      if (!product) throw new NotFoundException("Producto no encontrado");

      const qty = validateProductQuantity(product.unit, Math.abs(dto.quantity), product.name);
      const signedQty = dto.quantity < 0 ? -qty : qty;
      const currentStock = Number(product.stock);
      const stockAfter = round3(currentStock + signedQty);
      if (stockAfter < 0) {
        throw new BadRequestException(
          `Stock insuficiente. Disponible: ${currentStock}, solicitado: ${Math.abs(dto.quantity)}`
        );
      }

      const business = await tx.business.findUnique({
        where: { id: businessId },
        select: { id: true, tracksBatches: true },
      });
      const isTracked = this.batchesService.isTracked(business, product);

      let adjustedBatchId: string | null = null;
      if (isTracked) {
        const res = await this.batchesService.adjust(tx, {
          businessId,
          productId,
          delta: signedQty,
        });
        if (res) adjustedBatchId = res.batchId;
      } else {
        await tx.product.update({ where: { id: productId }, data: { stock: stockAfter } });
      }

      const movement = await tx.stockMovement.create({
        data: {
          businessId,
          productId,
          userId,
          type: dto.type,
          quantity: signedQty,
          stockBefore: currentStock,
          stockAfter,
          cost: dto.cost != null ? new Prisma.Decimal(dto.cost.toString()) : null,
          concept: dto.concept,
          reference: dto.reference,
          batchId: adjustedBatchId,
        },
      });

      this.logger.log(
        `[adjustStock] producto=${productId} antes=${currentStock} despues=${stockAfter} tipo=${dto.type}`
      );

      return { stockBefore: currentStock, stockAfter, movement };
    });
  }

  async getStockMovements(
    productId: string,
    businessId: string,
    filters?: {
      type?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId } });
    if (!product) throw new NotFoundException("Producto no encontrado");

    const where: any = { productId, businessId };
    if (filters?.type) where.type = filters.type;
    if (filters?.from || filters?.to) {
      where.createdAt = buildBusinessDateRange(filters.from, filters.to);
    }

    const page = Math.max(1, Number(filters?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters?.limit) || 20));
    const skip = (page - 1) * limit;

    const [total, data] = await Promise.all([
      this.prisma.stockMovement.count({ where }),
      this.prisma.stockMovement.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    return {
      product: {
        id: product.id,
        name: product.name,
        currentStock: Number(product.stock),
        unit: product.unit || 'UND',
        trackStock: product.trackStock,
      },
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getRecipeComponents(
    productId: string,
    businessId: string,
    tx?: Prisma.TransactionClient | PrismaService,
  ) {
    const db = tx || this.prisma;
    const product = await db.product.findFirst({
      where: { id: productId, businessId },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    const components = await db.productComponent.findMany({
      where: { parentProductId: productId, businessId },
      include: {
        componentProduct: {
          select: {
            id: true,
            name: true,
            unit: true,
            stock: true,
            trackStock: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return components.map((c) => ({
      id: c.id,
      productId: c.componentProductId,
      name: c.componentProduct.name,
      unit: c.componentProduct.unit || 'UND',
      currentStock: Number(c.componentProduct.stock),
      quantity: Number(c.quantity),
    }));
  }

  async setRecipeComponents(
    productId: string,
    dto: SetRecipeComponentsDto,
    businessId: string,
    user: JwtPayload,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
      include: {
        recipeComponents: true,
      },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    const incoming = dto.components || [];

    // Si viene lista vacía: quita la receta y pone isRecipe = false
    if (incoming.length === 0) {
      const prevComponents = product.recipeComponents.map((c) => ({
        productId: c.componentProductId,
        quantity: Number(c.quantity),
      }));

      await this.prisma.$transaction(async (tx) => {
        await tx.productComponent.deleteMany({
          where: { parentProductId: productId, businessId },
        });

        await tx.product.update({
          where: { id: productId },
          data: { isRecipe: false },
        });

        await this.auditService.record(
          {
            businessId,
            userId: user.sub,
            userRole: user.role,
            action: 'RECIPE_UPDATED',
            entityType: 'PRODUCT',
            entityId: productId,
            before: {
              isRecipe: product.isRecipe,
              components: prevComponents,
            },
            after: {
              isRecipe: false,
              components: [],
            },
            reason: 'Receta eliminada / convertida a producto simple',
          },
          tx,
        );
      });

      return [];
    }

    // Regla: el padre debe tener trackStock = false (el servicio no tiene stock propio)
    if (product.trackStock) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'RECIPE_PARENT_TRACKS_STOCK',
        message: 'El producto padre debe tener trackStock = false (el servicio no tiene stock propio)',
      });
    }

    // Regla: no duplicados en la lista de componentes
    const seenIds = new Set<string>();
    for (const comp of incoming) {
      if (seenIds.has(comp.productId)) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'RECIPE_DUPLICATE_COMPONENT',
          message: `El componente "${comp.productId}" está duplicado en la lista`,
        });
      }
      seenIds.add(comp.productId);
    }

    // Regla: no auto-referencia
    if (seenIds.has(productId)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'RECIPE_SELF_REFERENCE',
        message: 'Un producto no puede ser componente de sí mismo',
      });
    }

    // Regla: un componente no puede ser otro que a su vez sea receta (un solo nivel, sin recetas anidadas)
    // También verificar que el producto padre no sea actualmente componente de otra receta
    const usedInOtherRecipe = await this.prisma.productComponent.findFirst({
      where: { componentProductId: productId, businessId },
      include: { parentProduct: { select: { name: true } } },
    });
    if (usedInOtherRecipe) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'RECIPE_NESTED_NOT_ALLOWED',
        message: `El producto ya es componente de la receta "${usedInOtherRecipe.parentProduct?.name}". No se permiten recetas anidadas`,
      });
    }

    // Consultar todos los componentes de la base de datos pertenecientes al mismo businessId
    const componentProducts = await this.prisma.product.findMany({
      where: {
        id: { in: Array.from(seenIds) },
        businessId,
      },
    });

    if (componentProducts.length !== seenIds.size) {
      throw new NotFoundException('Uno o más productos componentes no fueron encontrados o pertenecen a otro negocio');
    }

    const componentMap = new Map(componentProducts.map((p) => [p.id, p]));

    // Validar cada componente
    const validatedData: { businessId: string; parentProductId: string; componentProductId: string; quantity: number }[] = [];

    for (const comp of incoming) {
      const compProd = componentMap.get(comp.productId)!;

      // Regla: los componentes deben tener trackStock = true
      if (!compProd.trackStock) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'RECIPE_COMPONENT_NOT_STOCKED',
          message: `El componente "${compProd.name}" no controla inventario (trackStock = false)`,
        });
      }

      // Regla: sin recetas anidadas
      if (compProd.isRecipe) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: 'RECIPE_NESTED_NOT_ALLOWED',
          message: `El componente "${compProd.name}" es una receta. No se permiten recetas anidadas`,
        });
      }

      // Regla: cantidad > 0. Si el componente es UND, la cantidad de la receta debe ser entera.
      if (!comp.quantity || comp.quantity <= 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_QUANTITY',
          message: `La cantidad del componente "${compProd.name}" debe ser mayor a 0`,
        });
      }

      const qty = validateProductQuantity(compProd.unit, comp.quantity, compProd.name);
      if (qty <= 0) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_QUANTITY',
          message: `La cantidad del componente "${compProd.name}" debe ser mayor a 0`,
        });
      }

      validatedData.push({
        businessId,
        parentProductId: productId,
        componentProductId: comp.productId,
        quantity: qty,
      });
    }

    const prevComponents = product.recipeComponents.map((c) => ({
      productId: c.componentProductId,
      quantity: Number(c.quantity),
    }));

    return await this.prisma.$transaction(async (tx) => {
      // Reemplaza el conjunto completo
      await tx.productComponent.deleteMany({
        where: { parentProductId: productId, businessId },
      });

      await tx.productComponent.createMany({
        data: validatedData,
      });

      await tx.product.update({
        where: { id: productId },
        data: { isRecipe: true },
      });

      await this.auditService.record(
        {
          businessId,
          userId: user.sub,
          userRole: user.role,
          action: 'RECIPE_UPDATED',
          entityType: 'PRODUCT',
          entityId: productId,
          before: {
            isRecipe: product.isRecipe,
            components: prevComponents,
          },
          after: {
            isRecipe: true,
            components: validatedData.map((c) => ({
              productId: c.componentProductId,
              quantity: c.quantity,
            })),
          },
          reason: 'Componentes de receta actualizados',
        },
        tx,
      );

      return this.getRecipeComponents(productId, businessId, tx);
    });
  }
}

