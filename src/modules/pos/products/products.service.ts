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
import { validateProductQuantity, round3 } from "./product-unit.util";

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) { }

  private mapProductWithInventory(product: any) {
    if (!product) return product;
    const { recipeComponents: rawComponents, ...rest } = product;
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

    return {
      ...rest,
      stock: product.stock != null ? Number(product.stock) : 0,
      minStock: product.minStock != null ? Number(product.minStock) : 0,
      maxStock: product.maxStock != null ? Number(product.maxStock) : null,
      unit: product.unit || 'UND',
      trackInventory: product.trackStock,
      isRecipe,
      ...(isRecipe && components ? { components } : {}),
    };
  }

  private filterActiveAttributes(product: any, activeKeys: Set<string>, userRole?: string) {
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

    const mapped = {
      ...this.mapProductWithInventory(product),
      attributes: filteredAttrs,
    };

    if (userRole === UserRole.CAJERO || userRole === UserRole.WAITER) {
      delete mapped.cost;
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
    });
    const inactiveFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: false },
    });

    const activeMap = new Map(activeFields.map((f) => [f.key, f]));
    const inactiveMap = new Map(inactiveFields.map((f) => [f.key, f]));

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
    });

    if (filters?.lowStock) {
      return products
        .filter((p) => p.trackStock && Number(p.stock) <= Number(p.minStock))
        .map((p) => this.filterActiveAttributes(p, activeKeys, userRole));
    }

    return products.map((p) => this.filterActiveAttributes(p, activeKeys, userRole));
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

    return this.filterActiveAttributes(product, activeKeys, userRole);
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

    return this.filterActiveAttributes(product, activeKeys, userRole);
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

    const { trackInventory, attributes: _ignored, ...productData } = dto;

    const product = await this.prisma.product.create({
      data: {
        ...productData,
        unit,
        trackStock,
        attributes: validatedAttributes,
        businessId,
      },
      include: { category: true, supplier: { select: { id: true, name: true } } },
    });

    const initialStock = Number(product.stock);
    if (product.trackStock && initialStock > 0) {
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
          },
        });
      }
    }

    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      select: { key: true },
    });
    const activeKeys = new Set(activeFields.map((f) => f.key));

    return this.filterActiveAttributes(product, activeKeys);
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

    const trackStock = dto.trackStock ?? dto.trackInventory;
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

    const { trackInventory, attributes: incomingAttributes, ...updateData } = dto;
    if (trackStock !== undefined) {
      (updateData as any).trackStock = trackStock;
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

      const qty = validateProductQuantity(product.unit, Math.abs(dto.quantity), product.name);
      const signedQty = dto.quantity < 0 ? -qty : qty;
      const currentStock = Number(product.stock);
      const stockAfter = round3(currentStock + signedQty);
      if (stockAfter < 0) {
        throw new BadRequestException(
          `Stock insuficiente. Disponible: ${currentStock}, solicitado: ${Math.abs(dto.quantity)}`
        );
      }

      await tx.product.update({ where: { id: productId }, data: { stock: stockAfter } });

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
      where.createdAt = {};
      if (filters.from) {
        where.createdAt.gte = filters.from.includes('T') ? new Date(filters.from) : new Date(`${filters.from}T00:00:00.000Z`);
      }
      if (filters.to) {
        where.createdAt.lte = filters.to.includes('T') ? new Date(filters.to) : new Date(`${filters.to}T23:59:59.999Z`);
      }
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

