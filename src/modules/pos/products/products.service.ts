import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { AdjustStockDto } from "./dto/adjust-stock.dto";

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: "insensitive" } },
        { barcode: { contains: filters.search, mode: "insensitive" } },
        { sku: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    const products = await this.prisma.product.findMany({
      where,
      include: { category: true, supplier: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });

    if (filters?.lowStock) {
      return products.filter((p) => p.trackStock && p.stock <= p.minStock);
    }

    return products;
  }

  async findOne(id: string, businessId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, businessId },
      include: { category: true, supplier: true },
    });
    if (!product) throw new NotFoundException("Producto no encontrado");
    return product;
  }

  async findByBarcode(businessId: string, barcode: string) {
    this.logger.log(`[findByBarcode] barcode=${barcode} businessId=${businessId}`);
    const product = await this.prisma.product.findFirst({
      where: { businessId, barcode, isActive: true },
      include: { category: true },
    });
    if (!product) throw new NotFoundException("Producto no encontrado");
    return product;
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

    return this.prisma.product.create({
      data: { ...dto, businessId },
      include: { category: true },
    });
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

    this.logger.log(`[update] id=${id} businessId=${businessId}`);
    return this.prisma.product.update({
      where: { id },
      data: dto,
      include: { category: true },
    });
  }

  async remove(id: string, businessId: string) {
    const product = await this.prisma.product.findFirst({ where: { id, businessId } });
    if (!product) throw new NotFoundException("Producto no encontrado");
    return this.prisma.product.update({ where: { id }, data: { isActive: false } });
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
