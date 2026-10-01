import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
} from "@nestjs/common";
import { BusinessProductType, PosVertical, ProductFieldDataType } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { AdjustStockDto } from "./dto/adjust-stock.dto";

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private mapProductWithInventory(product: any) {
    if (!product) return product;
    return {
      ...product,
      trackInventory: product.trackStock,
    };
  }

  private filterActiveAttributes(product: any, activeKeys: Set<string>) {
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
    }

    return {
      ...this.mapProductWithInventory(product),
      attributes: filteredAttrs,
    };
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
    });
    const inactiveFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: false },
    });

    const activeMap = new Map(activeFields.map((f) => [f.key, f]));
    const inactiveMap = new Map(inactiveFields.map((f) => [f.key, f]));

    // 1. Claves desconocidas
    for (const key of Object.keys(incomingAttributes)) {
      if (!activeMap.has(key)) {
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
    for (const field of activeFields) {
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

    // 3. Validar tipos de datos y opciones de SELECT
    for (const [key, val] of Object.entries(incomingAttributes)) {
      const field = activeMap.get(key);
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
      if (activeMap.has(k)) {
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
    }
  ) {
    const where: any = { businessId };

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    } else {
      where.isActive = true;
    }

    if (filters?.categoryId) where.categoryId = filters.categoryId;

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

    const products = await this.prisma.product.findMany({
      where,
      include: { category: true, supplier: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });

    if (filters?.lowStock) {
      return products
        .filter((p) => p.trackStock && p.stock <= p.minStock)
        .map((p) => this.filterActiveAttributes(p, activeKeys));
    }

    return products.map((p) => this.filterActiveAttributes(p, activeKeys));
  }

  async findOne(id: string, businessId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, businessId },
      include: { category: true, supplier: true },
    });
    if (!product) throw new NotFoundException("Producto no encontrado");

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    return this.filterActiveAttributes(product, activeKeys);
  }

  async findByBarcode(businessId: string, barcode: string) {
    this.logger.log(`[findByBarcode] barcode=${barcode} businessId=${businessId}`);
    const product = await this.prisma.product.findFirst({
      where: { businessId, barcode, isActive: true },
      include: { category: true },
    });
    if (!product) throw new NotFoundException("Producto no encontrado");

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    return this.filterActiveAttributes(product, activeKeys);
  }

  async create(dto: CreateProductDto, businessId: string) {
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

    const { trackInventory, attributes: _ignored, ...productData } = dto;

    const product = await this.prisma.product.create({
      data: {
        ...productData,
        trackStock,
        attributes: validatedAttributes,
        businessId,
      },
      include: { category: true, supplier: { select: { id: true, name: true } } },
    });

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    return this.filterActiveAttributes(product, activeKeys);
  }

  async update(id: string, dto: UpdateProductDto, businessId: string) {
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

    const trackStock = dto.trackStock ?? dto.trackInventory;
    const { trackInventory, attributes: incomingAttributes, ...updateData } = dto;
    if (trackStock !== undefined) {
      (updateData as any).trackStock = trackStock;
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

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    return this.filterActiveAttributes(updated, activeKeys);
  }

  async remove(id: string, businessId: string) {
    const product = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!product) throw new NotFoundException("Producto no encontrado");
    const removed = await this.prisma.product.update({ where: { id }, data: { isActive: false } });
    return this.mapProductWithInventory(removed);
  }

  async adjustStock(productId: string, dto: AdjustStockDto, userId: string, businessId: string) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findFirst({ where: { id: productId, businessId } });
      if (!product) throw new NotFoundException("Producto no encontrado");

      const stockAfter = product.stock + dto.quantity;
      if (stockAfter < 0) {
        throw new BadRequestException(
          `Stock insuficiente. Disponible: ${product.stock}, solicitado: ${Math.abs(dto.quantity)}`
        );
      }

      await tx.product.update({ where: { id: productId }, data: { stock: stockAfter } });

      const movement = await tx.stockMovement.create({
        data: {
          businessId,
          productId,
          userId,
          type: dto.type,
          quantity: dto.quantity,
          stockBefore: product.stock,
          stockAfter,
          cost: dto.cost,
          concept: dto.concept,
          reference: dto.reference,
        },
      });

      this.logger.log(
        `[adjustStock] producto=${productId} antes=${product.stock} despues=${stockAfter} tipo=${dto.type}`
      );

      return { stockBefore: product.stock, stockAfter, movement };
    });
  }

  async getStockMovements(productId: string, businessId: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, businessId } });
    if (!product) throw new NotFoundException("Producto no encontrado");

    return this.prisma.stockMovement.findMany({
      where: { productId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
}

