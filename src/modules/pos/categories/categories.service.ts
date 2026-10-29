import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    this.logger.log('[findAll] businessId=' + businessId);
    return this.prisma.category.findMany({
      where: { businessId, isActive: true },
      include: { _count: { select: { products: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * 214a: Resumen de categorías con conteo de productos activos/inactivos
   * y valor del inventario al costo (solo para ENCARGADO/SUPERADMIN).
   * Incluye la fila "Sin categoría".
   */
  async getSummary(businessId: string, userRole?: string) {
    this.logger.log(`[getSummary] businessId=${businessId} userRole=${userRole}`);

    const categories = await this.prisma.category.findMany({
      where: { businessId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const aggs = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT
         p."categoryId",
         COUNT(*) FILTER (WHERE p."isActive" = true)::int AS "activeProducts",
         COUNT(*) FILTER (WHERE p."isActive" = false)::int AS "inactiveProducts",
         COALESCE(SUM(CASE WHEN p."isActive" = true THEN (p."stock"::numeric * COALESCE(p."cost"::numeric, 0)) ELSE 0 END), 0)::float AS "inventoryCostValue"
       FROM "pos_products" p
       WHERE p."businessId" = $1
       GROUP BY p."categoryId";`,
      businessId,
    );

    const canViewCost =
      userRole === UserRole.ENCARGADO || userRole === UserRole.SUPERADMIN;

    const aggMap = new Map<
      string,
      { activeProducts: number; inactiveProducts: number; inventoryCostValue: number }
    >();
    let uncatAgg = { activeProducts: 0, inactiveProducts: 0, inventoryCostValue: 0 };

    for (const row of aggs) {
      const item = {
        activeProducts: Number(row.activeProducts || 0),
        inactiveProducts: Number(row.inactiveProducts || 0),
        inventoryCostValue: Number(row.inventoryCostValue || 0),
      };
      if (!row.categoryId) {
        uncatAgg = item;
      } else {
        aggMap.set(row.categoryId, item);
      }
    }

    const items = categories.map((cat) => {
      const agg = aggMap.get(cat.id) || {
        activeProducts: 0,
        inactiveProducts: 0,
        inventoryCostValue: 0,
      };
      const activeProducts = agg.activeProducts;
      const inactiveProducts = agg.inactiveProducts;
      return {
        id: cat.id,
        name: cat.name,
        color: cat.color ?? null,
        description: cat.description ?? null,
        sortOrder: cat.sortOrder ?? 0,
        isActive: cat.isActive,
        activeProducts,
        inactiveProducts,
        totalProducts: activeProducts + inactiveProducts,
        inventoryCostValue: canViewCost
          ? Math.round(agg.inventoryCostValue * 100) / 100
          : null,
      };
    });

    // Fila "Sin categoría"
    items.push({
      id: null,
      name: 'Sin categoría',
      color: null,
      description: null,
      sortOrder: null,
      isActive: true,
      activeProducts: uncatAgg.activeProducts,
      inactiveProducts: uncatAgg.inactiveProducts,
      totalProducts: uncatAgg.activeProducts + uncatAgg.inactiveProducts,
      inventoryCostValue: canViewCost
        ? Math.round(uncatAgg.inventoryCostValue * 100) / 100
        : null,
    });

    return items;
  }

  async create(dto: CreateCategoryDto, businessId: string) {
    this.logger.log('[create] name=' + dto.name + ' businessId=' + businessId);
    const existing = await this.prisma.category.findUnique({
      where: { businessId_name: { businessId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException('La categoría "' + dto.name + '" ya existe');
    }
    return this.prisma.category.create({
      data: {
        name: dto.name,
        color: dto.color ?? null,
        icon: dto.icon ?? null,
        description: dto.description ?? null,
        sortOrder: dto.sortOrder !== undefined ? dto.sortOrder : 0,
        businessId,
      },
    });
  }

  async update(id: string, dto: UpdateCategoryDto, businessId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, businessId },
    });
    if (!category) throw new NotFoundException('Categoría no encontrada');

    if (dto.name && dto.name !== category.name) {
      const existing = await this.prisma.category.findUnique({
        where: { businessId_name: { businessId, name: dto.name } },
      });
      if (existing) throw new ConflictException('La categoría "' + dto.name + '" ya existe');
    }

    this.logger.log('[update] id=' + id + ' businessId=' + businessId);
    return this.prisma.category.update({
      where: { id },
      data: {
        name: dto.name !== undefined ? dto.name : undefined,
        color: dto.color !== undefined ? dto.color : undefined,
        description: dto.description !== undefined ? dto.description : undefined,
        icon: dto.icon !== undefined ? dto.icon : undefined,
        sortOrder: dto.sortOrder !== undefined ? dto.sortOrder : undefined,
        isActive: dto.isActive !== undefined ? dto.isActive : undefined,
      },
    });
  }

  /**
   * 214a: Reordenar categorías del negocio
   */
  async reorder(businessId: string, categoryIds: string[]) {
    this.logger.log(`[reorder] businessId=${businessId} count=${categoryIds.length}`);
    const existing = await this.prisma.category.findMany({
      where: { businessId, id: { in: categoryIds } },
      select: { id: true },
    });

    if (existing.length !== categoryIds.length) {
      throw new BadRequestException('Algunos IDs de categorías no pertenecen a este negocio');
    }

    await this.prisma.$transaction(
      categoryIds.map((id, index) =>
        this.prisma.category.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
    );

    return this.findAll(businessId);
  }

  /**
   * 214a: Mover todos los productos de una categoría a otra (o a 'Sin categoría')
   */
  async moveProducts(
    sourceCategoryId: string,
    targetCategoryId: string | null | undefined,
    businessId: string,
  ) {
    const sourceCat = await this.prisma.category.findFirst({
      where: { id: sourceCategoryId, businessId },
    });
    if (!sourceCat) {
      throw new NotFoundException('Categoría origen no encontrada');
    }

    const cleanTarget =
      targetCategoryId && targetCategoryId.trim() !== '' ? targetCategoryId.trim() : null;

    if (cleanTarget) {
      if (cleanTarget === sourceCategoryId) {
        throw new BadRequestException('La categoría destino no puede ser la misma que la categoría origen');
      }
      const targetCat = await this.prisma.category.findFirst({
        where: { id: cleanTarget, businessId },
      });
      if (!targetCat) {
        throw new NotFoundException('Categoría destino no encontrada');
      }
    }

    const movedCount = await this.prisma.$transaction(async (tx) => {
      const res = await tx.product.updateMany({
        where: { businessId, categoryId: sourceCategoryId },
        data: { categoryId: cleanTarget },
      });
      if (res.count > 0) {
        await tx.$executeRawUnsafe(
          `UPDATE "pos_products" SET "updatedAt" = NOW() WHERE "businessId" = $1 AND "categoryId" IS NOT DISTINCT FROM $2;`,
          businessId,
          cleanTarget,
        );
      }
      return res.count;
    });

    this.logger.log(`[moveProducts] moved=${movedCount} from=${sourceCategoryId} to=${cleanTarget}`);

    return {
      movedCount,
      sourceCategoryId,
      targetCategoryId: cleanTarget,
    };
  }

  /**
   * 214a: Borrado seguro:
   * - Si tiene productos: 409 CATEGORY_HAS_PRODUCTS con cantidad.
   * - Si no tiene productos: borrado real.
   */
  async remove(id: string, businessId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, businessId },
    });
    if (!category) throw new NotFoundException('Categoría no encontrada');

    const productCount = await this.prisma.product.count({
      where: { businessId, categoryId: id },
    });

    if (productCount > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'CATEGORY_HAS_PRODUCTS',
        message: `No se puede eliminar la categoría porque tiene ${productCount} producto(s) asignado(s). Puedes mover sus productos a otra categoría antes de eliminarla.`,
        productCount,
      });
    }

    this.logger.log('[remove] deleting category id=' + id + ' businessId=' + businessId);
    await this.prisma.category.delete({ where: { id } });

    return { deleted: true, id };
  }
}