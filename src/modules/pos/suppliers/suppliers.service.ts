import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

@Injectable()
export class SuppliersService {
  private readonly logger = new Logger(SuppliersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    return this.prisma.supplier.findMany({
      where: { businessId, isActive: true },
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async create(dto: CreateSupplierDto, businessId: string) {
    this.logger.log('[create] name=' + dto.name + ' businessId=' + businessId);
    return this.prisma.supplier.create({ data: { ...dto, businessId } });
  }

  async update(id: string, dto: UpdateSupplierDto, businessId: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id, businessId } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    this.logger.log('[update] id=' + id + ' businessId=' + businessId);
    return this.prisma.supplier.update({ where: { id }, data: dto });
  }

  async remove(id: string, businessId: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id, businessId } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    return this.prisma.supplier.update({ where: { id }, data: { isActive: false } });
  }
}