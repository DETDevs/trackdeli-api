import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreatePresentationDto } from './dto/create-presentation.dto';
import { UpdatePresentationDto } from './dto/update-presentation.dto';
import { round3 } from './product-unit.util';

export const MAX_ACTIVE_PRESENTATIONS_PER_PRODUCT = 5;

export function canSeePresentationCost(userRole?: string): boolean {
  return !userRole || userRole === UserRole.ENCARGADO || userRole === UserRole.SUPERADMIN;
}

export function formatPresentation(p: any, userRole?: string, productStock?: number | null) {
  if (!p) return null;
  const factorNum = p.factor != null ? Number(p.factor) : 1;
  const formatted: Record<string, any> = {
    id: p.id,
    businessId: p.businessId,
    productId: p.productId,
    name: p.name,
    factor: factorNum,
    price: p.price != null ? Number(p.price) : 0,
    listPrice: p.listPrice != null ? Number(p.listPrice) : null,
    wholesalePrice: p.wholesalePrice != null ? Number(p.wholesalePrice) : null,
    wholesaleMinQty: p.wholesaleMinQty != null ? Number(p.wholesaleMinQty) : null,
    barcode: p.barcode ?? null,
    sku: p.sku ?? null,
    isDefaultPurchase: Boolean(p.isDefaultPurchase),
    sortOrder: p.sortOrder != null ? Number(p.sortOrder) : 0,
    isActive: Boolean(p.isActive),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };

  if (productStock !== undefined && productStock !== null) {
    const stockNum = Number(productStock);
    formatted.availableUnits =
      Number.isFinite(stockNum) && factorNum > 0
        ? Math.floor(Math.max(0, stockNum) / factorNum)
        : 0;
  }

  if (canSeePresentationCost(userRole)) {
    formatted.cost = p.cost != null ? Number(p.cost) : null;
  }

  return formatted;
}

@Injectable()
export class ProductPresentationsService {
  constructor(private readonly prisma: PrismaService) {}

  private validateWholesalePair(
    price: number,
    wholesalePrice: number | null | undefined,
    wholesaleMinQty: number | null | undefined,
  ): void {
    const hasPrice = wholesalePrice !== undefined && wholesalePrice !== null;
    const hasMinQty = wholesaleMinQty !== undefined && wholesaleMinQty !== null;

    if (!hasPrice && !hasMinQty) return;

    if (hasPrice && !hasMinQty) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'WHOLESALE_MIN_QTY_REQUIRED',
        message: 'Si definís precio por mayor en la presentación, debés indicar la cantidad mínima.',
      });
    }
    if (!hasPrice && hasMinQty) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'WHOLESALE_PRICE_REQUIRED',
        message: 'Si definís cantidad mínima por mayor, debés indicar el precio por mayor.',
      });
    }

    const wp = Number(wholesalePrice);
    const wq = Number(wholesaleMinQty);

    if (!Number.isFinite(wp) || wp <= 0) {
      throw new BadRequestException('El precio por mayor de la presentación debe ser mayor a 0.');
    }
    if (wp >= price) {
      throw new BadRequestException(
        'El precio por mayor de la presentación debe ser menor que su precio normal.',
      );
    }
    if (!Number.isFinite(wq) || wq < 2 || !Number.isInteger(wq)) {
      throw new BadRequestException(
        'La cantidad mínima por mayor de la presentación debe ser un entero mayor o igual a 2.',
      );
    }
  }

  private async assertBarcodeAvailable(
    tx: Prisma.TransactionClient,
    businessId: string,
    barcode: string,
    excludePresentationId?: string,
  ): Promise<void> {
    const existingProduct = await tx.product.findFirst({
      where: { businessId, barcode },
      select: { id: true },
    });
    if (existingProduct) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BARCODE_TAKEN',
        message: `El código de barras "${barcode}" ya está en uso en este negocio.`,
      });
    }

    const existingPres = await tx.productPresentation.findFirst({
      where: {
        businessId,
        barcode,
        ...(excludePresentationId ? { NOT: { id: excludePresentationId } } : {}),
      },
      select: { id: true },
    });
    if (existingPres) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BARCODE_TAKEN',
        message: `El código de barras "${barcode}" ya está en uso en este negocio.`,
      });
    }
  }

  async findByProduct(
    businessId: string,
    productId: string,
    includeInactive = false,
    userRole?: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
      select: { id: true, stock: true },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado.');
    }

    const canSeeInactive =
      includeInactive &&
      (!userRole || userRole === UserRole.ENCARGADO || userRole === UserRole.SUPERADMIN);

    const rows = await this.prisma.productPresentation.findMany({
      where: {
        businessId,
        productId,
        ...(canSeeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const productStock = Number(product.stock ?? 0);
    return rows.map((p) => formatPresentation(p, userRole, productStock));
  }

  async create(businessId: string, productId: string, dto: CreatePresentationDto) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
      select: { id: true, isVariantParent: true, parentProductId: true, stock: true },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado.');
    }

    if (product.isVariantParent || product.parentProductId) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PRODUCT_HAS_VARIANTS',
        message:
          'Un producto con variantes no puede tener presentaciones. Usá variantes o presentaciones, pero no ambas.',
      });
    }

    const name = (dto.name || '').trim();
    if (!name) {
      throw new BadRequestException('El nombre de la presentación es obligatorio.');
    }

    const factor = round3(Number(dto.factor));
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new BadRequestException('El factor de conversión debe ser mayor que 0.');
    }

    const price = Number(dto.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new BadRequestException('El precio de la presentación debe ser mayor o igual a 0.');
    }

    this.validateWholesalePair(price, dto.wholesalePrice, dto.wholesaleMinQty);

    const barcode = dto.barcode?.trim() || null;
    const sku = dto.sku?.trim() || null;

    const created = await this.prisma.$transaction(async (tx) => {
      const activeCount = await tx.productPresentation.count({
        where: { businessId, productId, isActive: true },
      });
      if (activeCount >= MAX_ACTIVE_PRESENTATIONS_PER_PRODUCT) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'PRESENTATION_LIMIT_EXCEEDED',
          message: `Solo podés tener hasta ${MAX_ACTIVE_PRESENTATIONS_PER_PRODUCT} presentaciones activas por producto.`,
        });
      }

      const duplicateName = await tx.productPresentation.findFirst({
        where: {
          businessId,
          productId,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (duplicateName) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'PRESENTATION_NAME_TAKEN',
          message: `Ya existe una presentación llamada "${name}" en este producto.`,
        });
      }

      if (barcode) {
        await this.assertBarcodeAvailable(tx, businessId, barcode);
      }

      if (dto.isDefaultPurchase) {
        await tx.productPresentation.updateMany({
          where: { businessId, productId },
          data: { isDefaultPurchase: false },
        });
      }

      return tx.productPresentation.create({
        data: {
          businessId,
          productId,
          name,
          factor: new Prisma.Decimal(factor),
          price: new Prisma.Decimal(price),
          listPrice: dto.listPrice != null ? new Prisma.Decimal(Number(dto.listPrice)) : null,
          wholesalePrice:
            dto.wholesalePrice != null ? new Prisma.Decimal(Number(dto.wholesalePrice)) : null,
          wholesaleMinQty:
            dto.wholesaleMinQty != null ? new Prisma.Decimal(Number(dto.wholesaleMinQty)) : null,
          barcode,
          sku,
          cost: dto.cost != null ? new Prisma.Decimal(Number(dto.cost)) : null,
          isDefaultPurchase: Boolean(dto.isDefaultPurchase),
          sortOrder: dto.sortOrder !== undefined ? Number(dto.sortOrder) : 0,
          isActive: true,
        },
      });
    });

    return formatPresentation(created, UserRole.ENCARGADO, Number(product.stock ?? 0));
  }

  async update(
    businessId: string,
    productId: string,
    presentationId: string,
    dto: UpdatePresentationDto,
  ) {
    const existing = await this.prisma.productPresentation.findFirst({
      where: { id: presentationId, productId, businessId },
      include: { product: { select: { stock: true } } },
    });
    if (!existing) {
      throw new NotFoundException('Presentación no encontrada.');
    }

    let nextName: string | undefined;
    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (!trimmed) {
        throw new BadRequestException('El nombre de la presentación no puede estar vacío.');
      }
      nextName = trimmed;
    }

    let nextFactor: Prisma.Decimal | undefined;
    if (dto.factor !== undefined) {
      const f = round3(Number(dto.factor));
      if (!Number.isFinite(f) || f <= 0) {
        throw new BadRequestException('El factor de conversión debe ser mayor que 0.');
      }
      nextFactor = new Prisma.Decimal(f);
    }

    const effectivePrice = dto.price !== undefined ? Number(dto.price) : Number(existing.price);
    if (!Number.isFinite(effectivePrice) || effectivePrice < 0) {
      throw new BadRequestException('El precio de la presentación debe ser mayor o igual a 0.');
    }

    const effectiveWholesalePrice =
      dto.wholesalePrice !== undefined
        ? dto.wholesalePrice
        : existing.wholesalePrice != null
          ? Number(existing.wholesalePrice)
          : null;
    const effectiveWholesaleMinQty =
      dto.wholesaleMinQty !== undefined
        ? dto.wholesaleMinQty
        : existing.wholesaleMinQty != null
          ? Number(existing.wholesaleMinQty)
          : null;

    if (
      dto.price !== undefined ||
      dto.wholesalePrice !== undefined ||
      dto.wholesaleMinQty !== undefined
    ) {
      this.validateWholesalePair(effectivePrice, effectiveWholesalePrice, effectiveWholesaleMinQty);
    }

    const nextBarcode =
      dto.barcode !== undefined ? (dto.barcode ? dto.barcode.trim() : null) : undefined;
    const nextSku = dto.sku !== undefined ? (dto.sku ? dto.sku.trim() : null) : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (nextName !== undefined && nextName.toLowerCase() !== existing.name.toLowerCase()) {
        const duplicateName = await tx.productPresentation.findFirst({
          where: {
            businessId,
            productId,
            name: { equals: nextName, mode: 'insensitive' },
            NOT: { id: presentationId },
          },
          select: { id: true },
        });
        if (duplicateName) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'PRESENTATION_NAME_TAKEN',
            message: `Ya existe una presentación llamada "${nextName}" en este producto.`,
          });
        }
      }

      if (!existing.isActive && dto.isActive === true) {
        const activeCount = await tx.productPresentation.count({
          where: { businessId, productId, isActive: true },
        });
        if (activeCount >= MAX_ACTIVE_PRESENTATIONS_PER_PRODUCT) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'PRESENTATION_LIMIT_EXCEEDED',
            message: `Solo podés tener hasta ${MAX_ACTIVE_PRESENTATIONS_PER_PRODUCT} presentaciones activas por producto.`,
          });
        }
      }

      if (nextBarcode && nextBarcode !== existing.barcode) {
        await this.assertBarcodeAvailable(tx, businessId, nextBarcode, presentationId);
      }

      if (dto.isDefaultPurchase === true) {
        await tx.productPresentation.updateMany({
          where: { businessId, productId, NOT: { id: presentationId } },
          data: { isDefaultPurchase: false },
        });
      }

      return tx.productPresentation.update({
        where: { id: presentationId },
        data: {
          ...(nextName !== undefined && { name: nextName }),
          ...(nextFactor !== undefined && { factor: nextFactor }),
          ...(dto.price !== undefined && { price: new Prisma.Decimal(effectivePrice) }),
          ...(dto.listPrice !== undefined && {
            listPrice: dto.listPrice != null ? new Prisma.Decimal(Number(dto.listPrice)) : null,
          }),
          ...(dto.wholesalePrice !== undefined && {
            wholesalePrice:
              dto.wholesalePrice != null ? new Prisma.Decimal(Number(dto.wholesalePrice)) : null,
          }),
          ...(dto.wholesaleMinQty !== undefined && {
            wholesaleMinQty:
              dto.wholesaleMinQty != null ? new Prisma.Decimal(Number(dto.wholesaleMinQty)) : null,
          }),
          ...(nextBarcode !== undefined && { barcode: nextBarcode }),
          ...(nextSku !== undefined && { sku: nextSku }),
          ...(dto.cost !== undefined && {
            cost: dto.cost != null ? new Prisma.Decimal(Number(dto.cost)) : null,
          }),
          ...(dto.isDefaultPurchase !== undefined && {
            isDefaultPurchase: Boolean(dto.isDefaultPurchase),
          }),
          ...(dto.sortOrder !== undefined && { sortOrder: Number(dto.sortOrder) }),
          ...(dto.isActive !== undefined && { isActive: Boolean(dto.isActive) }),
        },
      });
    });

    return formatPresentation(updated, UserRole.ENCARGADO, Number(existing.product?.stock ?? 0));
  }

  async remove(businessId: string, productId: string, presentationId: string) {
    const existing = await this.prisma.productPresentation.findFirst({
      where: { id: presentationId, productId, businessId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Presentación no encontrada.');
    }

    const [usedInSales, usedInPurchases] = await Promise.all([
      this.prisma.saleItem.count({ where: { presentationId } }),
      this.prisma.purchaseItem.count({ where: { presentationId } }),
    ]);

    if (usedInSales + usedInPurchases > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'PRESENTATION_IN_USE',
        message: 'Ya se usó en ventas o compras. Desactivala en vez de borrarla.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productPresentation.delete({
        where: { id: presentationId },
      });
      await tx.product.update({
        where: { id: productId },
        data: { updatedAt: new Date() },
      });
    });

    return { deleted: true, id: presentationId };
  }
}
