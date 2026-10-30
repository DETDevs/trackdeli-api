import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateBankDto } from './dto/create-bank.dto';
import { UpdateBankDto } from './dto/update-bank.dto';

const DEFAULT_BANKS = [
  { name: 'BAC', code: 'BAC', order: 1 },
  { name: 'LAFISE', code: 'LAFISE', order: 2 },
  { name: 'BANPRO', code: 'BANPRO', order: 3 },
  { name: 'FICOHSA', code: 'FICOHSA', order: 4 },
  { name: 'AVANZ', code: 'AVANZ', order: 5 },
  { name: 'Otro', code: 'OTRO', order: 999 },
];

@Injectable()
export class BanksService {
  private readonly logger = new Logger(BanksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Asegura la inicialización de los bancos por defecto del negocio
   */
  async ensureDefaultBanks(businessId: string): Promise<void> {
    const count = await this.prisma.posBank.count({ where: { businessId } });
    if (count > 0) return;

    try {
      for (const b of DEFAULT_BANKS) {
        await this.prisma.posBank.upsert({
          where: {
            businessId_name: {
              businessId,
              name: b.name,
            },
          },
          update: {},
          create: {
            businessId,
            name: b.name,
            code: b.code,
            order: b.order,
            isActive: true,
            isDefault: true,
          },
        });
      }
      this.logger.log(`[ensureDefaultBanks] Bancos iniciales creados para negocio ${businessId}`);
    } catch (err: any) {
      this.logger.warn(`[ensureDefaultBanks] Error al crear bancos iniciales: ${err.message}`);
    }
  }

  async findAll(businessId: string, includeInactive = false) {
    await this.ensureDefaultBanks(businessId);

    const where: any = { businessId };
    if (!includeInactive) {
      where.isActive = true;
    }

    return this.prisma.posBank.findMany({
      where,
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string, businessId: string) {
    const bank = await this.prisma.posBank.findFirst({
      where: { id, businessId },
    });
    if (!bank) {
      throw new NotFoundException('Banco no encontrado');
    }
    return bank;
  }

  async create(businessId: string, dto: CreateBankDto, userId: string, userRole: string) {
    await this.ensureDefaultBanks(businessId);

    const trimmedName = dto.name.trim();
    const existing = await this.prisma.posBank.findFirst({
      where: {
        businessId,
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });

    if (existing) {
      throw new ConflictException(`Ya existe un banco con el nombre "${trimmedName}"`);
    }

    let order = dto.order;
    if (order === undefined || order === null) {
      const maxOrder = await this.prisma.posBank.aggregate({
        where: { businessId, order: { lt: 900 } },
        _max: { order: true },
      });
      order = (maxOrder._max.order || 0) + 1;
    }

    const bank = await this.prisma.posBank.create({
      data: {
        businessId,
        name: trimmedName,
        code: dto.code ? dto.code.trim().toUpperCase() : null,
        order,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
        isDefault: false,
      },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: 'BANCO_CREADO',
      entityType: 'PosBank',
      entityId: bank.id,
      after: bank,
    });

    return bank;
  }

  async update(id: string, businessId: string, dto: UpdateBankDto, userId: string, userRole: string) {
    const bank = await this.findOne(id, businessId);

    const data: any = {};
    if (dto.name !== undefined) {
      const trimmedName = dto.name.trim();
      if (trimmedName.toLowerCase() !== bank.name.toLowerCase()) {
        const existing = await this.prisma.posBank.findFirst({
          where: {
            businessId,
            name: { equals: trimmedName, mode: 'insensitive' },
            id: { not: id },
          },
        });
        if (existing) {
          throw new ConflictException(`Ya existe un banco con el nombre "${trimmedName}"`);
        }
      }
      data.name = trimmedName;
    }

    if (dto.code !== undefined) {
      data.code = dto.code ? dto.code.trim().toUpperCase() : null;
    }

    if (dto.order !== undefined) {
      data.order = dto.order;
    }

    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }

    const updated = await this.prisma.posBank.update({
      where: { id },
      data,
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: 'BANCO_ACTUALIZADO',
      entityType: 'PosBank',
      entityId: bank.id,
      before: bank,
      after: updated,
    });

    return updated;
  }

  async remove(id: string, businessId: string, userId: string, userRole: string) {
    const bank = await this.findOne(id, businessId);

    if (bank.name.trim().toLowerCase() === 'otro') {
      throw new BadRequestException(
        'La opción fija "Otro" no se puede eliminar. Puede desactivarla si no desea utilizarla.',
      );
    }

    const paymentsCount = await this.prisma.posPayment.count({
      where: { bankId: id },
    });

    if (paymentsCount > 0) {
      throw new BadRequestException(
        'No se puede eliminar un banco con pagos registrados. Desactívelo en su lugar.',
      );
    }

    await this.prisma.posBank.delete({
      where: { id },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole,
      action: 'BANCO_ELIMINADO',
      entityType: 'PosBank',
      entityId: id,
      before: bank,
    });

    return { success: true, message: 'Banco eliminado exitosamente' };
  }
}
