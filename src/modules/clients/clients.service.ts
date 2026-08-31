import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(businessId: string) {
    this.logger.log(`[findAll] Listando clientes para businessId=${businessId}`);
    return this.prisma.businessClient.findMany({
      where: { businessId, isActive: true },
      orderBy: { name: 'asc' },
    });
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
