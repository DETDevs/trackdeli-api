import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    businessId: string,
    options: {
      q?: string;
      page?: number;
      limit?: number;
      isActive?: boolean;
    } = {},
  ) {
    this.logger.log(
      `[findAll] Listando business-clients para businessId=${businessId} options=${JSON.stringify(options)}`,
    );

    const trimmed = (options.q || '').trim();
    const hasPagination = options.page !== undefined || options.limit !== undefined;
    const page = Math.max(1, Number(options.page) || 1);
    const limit = hasPagination
      ? Math.min(100, Math.max(1, Number(options.limit) || 50))
      : 100;
    const skip = (page - 1) * limit;

    const where: Prisma.BusinessClientWhereInput = {
      businessId,
      ...(options.isActive !== undefined ? { isActive: options.isActive } : {}),
      ...(trimmed
        ? {
            OR: [
              { name: { contains: trimmed, mode: 'insensitive' } },
              { phone: { contains: trimmed, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.businessClient.findMany({
        where,
        ...(hasPagination ? { skip, take: limit } : {}),
        orderBy: { name: 'asc' },
        include: {
          _count: {
            select: {
              orders: true,
            },
          },
        },
      }),
      this.prisma.businessClient.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit: hasPagination ? limit : total,
      totalPages: hasPagination ? Math.ceil(total / limit) : 1,
    };
  }

  async findOne(id: string, businessId: string) {
    const client = await this.prisma.businessClient.findFirst({
      where: { id, businessId },
    });
    if (!client) {
      throw new NotFoundException('Cliente no encontrado');
    }
    return client;
  }

  async create(dto: CreateClientDto, businessId: string) {
    this.logger.log(`[create] Creando cliente name="${dto.name}" para businessId=${businessId}`);
    return this.prisma.businessClient.create({
      data: {
        ...dto,
        businessId,
      },
    });
  }

  async update(id: string, dto: UpdateClientDto, businessId: string) {
    const client = await this.prisma.businessClient.findFirst({
      where: { id, businessId },
    });
    if (!client) {
      throw new NotFoundException('Cliente no encontrado');
    }

    this.logger.log(`[update] Actualizando cliente id=${id} businessId=${businessId}`);
    return this.prisma.businessClient.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string, businessId: string) {
    const client = await this.prisma.businessClient.findFirst({
      where: { id, businessId },
    });
    if (!client) {
      throw new NotFoundException('Cliente no encontrado');
    }

    this.logger.log(`[remove] Desactivando cliente id=${id} businessId=${businessId}`);
    return this.prisma.businessClient.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
