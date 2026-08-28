import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
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
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateCategoryDto, businessId: string) {
    this.logger.log('[create] name=' + dto.name + ' businessId=' + businessId);
    const existing = await this.prisma.category.findUnique({
      where: { businessId_name: { businessId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException('La categoria "' + dto.name + '" ya existe');
    }
    return this.prisma.category.create({
      data: { ...dto, businessId },
    });
  }

  async update(id: string, dto: UpdateCategoryDto, businessId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, businessId },
    });
    if (!category) throw new NotFoundException('Categoria no encontrada');

    if (dto.name && dto.name !== category.name) {
      const existing = await this.prisma.category.findUnique({
        where: { businessId_name: { businessId, name: dto.name } },
      });
      if (existing) throw new ConflictException('La categoria "' + dto.name + '" ya existe');
    }

    this.logger.log('[update] id=' + id + ' businessId=' + businessId);
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(id: string, businessId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, businessId },
    });
    if (!category) throw new NotFoundException('Categoria no encontrada');
    this.logger.log('[remove] id=' + id + ' businessId=' + businessId);
    return this.prisma.category.update({ where: { id }, data: { isActive: false } });
  }
}