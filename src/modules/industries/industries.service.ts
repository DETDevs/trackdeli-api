import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateIndustryDto } from './dto/create-industry.dto';
import { UpdateIndustryDto } from './dto/update-industry.dto';
import { CreateFieldTemplateDto } from './dto/create-field-template.dto';
import { UpdateFieldTemplateDto } from './dto/update-field-template.dto';
import { generateFieldKey } from '../../common/utils/field-key.util';
import { ProductFieldDataType } from '@prisma/client';

@Injectable()
export class IndustriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllActive() {
    return this.prisma.industry.findMany({
      where: { isActive: true },
      orderBy: { order: 'asc' },
      include: {
        fieldTemplates: {
          orderBy: { order: 'asc' },
        },
      },
    });
  }

  async findAllForSuperAdmin() {
    return this.prisma.industry.findMany({
      orderBy: { order: 'asc' },
      include: {
        _count: {
          select: { businesses: true },
        },
        fieldTemplates: {
          orderBy: { order: 'asc' },
        },
      },
    });
  }

  async findOne(id: string) {
    const industry = await this.prisma.industry.findUnique({
      where: { id },
      include: {
        fieldTemplates: {
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!industry) {
      throw new NotFoundException(`Industria con ID '${id}' no encontrada`);
    }
    return industry;
  }

  async create(dto: CreateIndustryDto) {
    const cleanCode = generateFieldKey(dto.code);
    if (!cleanCode) {
      throw new BadRequestException('El código de la industria no es válido');
    }

    const existing = await this.prisma.industry.findUnique({
      where: { code: cleanCode },
    });
    if (existing) {
      throw new ConflictException(`Ya existe una industria con el código '${cleanCode}'`);
    }

    return this.prisma.industry.create({
      data: {
        code: cleanCode,
        name: dto.name.trim(),
        posVertical: dto.posVertical || 'RETAIL',
        usesVariants: dto.usesVariants ?? false,
        tracksBatches: dto.tracksBatches ?? false,
        isActive: dto.isActive ?? true,
        order: dto.order ?? 0,
      },
      include: {
        fieldTemplates: true,
      },
    });
  }

  async update(id: string, dto: UpdateIndustryDto) {
    await this.findOne(id);

    return this.prisma.industry.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.posVertical !== undefined && { posVertical: dto.posVertical }),
        ...(dto.usesVariants !== undefined && { usesVariants: dto.usesVariants }),
        ...(dto.tracksBatches !== undefined && { tracksBatches: dto.tracksBatches }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.order !== undefined && { order: dto.order }),
      },
      include: {
        fieldTemplates: {
          orderBy: { order: 'asc' },
        },
      },
    });
  }

  async getFieldTemplates(industryId: string) {
    await this.findOne(industryId);
    return this.prisma.industryFieldTemplate.findMany({
      where: { industryId },
      orderBy: { order: 'asc' },
    });
  }

  async addFieldTemplate(industryId: string, dto: CreateFieldTemplateDto) {
    await this.findOne(industryId);

    const key = (dto.key ? generateFieldKey(dto.key) : generateFieldKey(dto.label));
    if (!key) {
      throw new BadRequestException('No se pudo generar una clave válida para la plantilla de campo');
    }

    if (dto.dataType === ProductFieldDataType.SELECT) {
      if (!Array.isArray(dto.options) || dto.options.length === 0) {
        throw new BadRequestException('Para campos de tipo SELECT, las opciones son obligatorias');
      }
    }

    const existing = await this.prisma.industryFieldTemplate.findUnique({
      where: {
        industryId_key: {
          industryId,
          key,
        },
      },
    });

    if (existing) {
      throw new ConflictException(`Ya existe un campo con la clave '${key}' en esta industria`);
    }

    return this.prisma.industryFieldTemplate.create({
      data: {
        industryId,
        key,
        label: dto.label.trim(),
        dataType: dto.dataType,
        required: dto.required ?? false,
        options: dto.dataType === ProductFieldDataType.SELECT ? dto.options : null,
        order: dto.order ?? 0,
        searchable: dto.searchable ?? false,
        showInPos: dto.showInPos ?? false,
      },
    });
  }

  async updateFieldTemplate(industryId: string, fieldId: string, dto: UpdateFieldTemplateDto) {
    await this.findOne(industryId);

    const template = await this.prisma.industryFieldTemplate.findUnique({
      where: { id: fieldId },
    });

    if (!template || template.industryId !== industryId) {
      throw new NotFoundException(`Plantilla de campo '${fieldId}' no encontrada en esta industria`);
    }

    const targetDataType = dto.dataType ?? template.dataType;
    if (targetDataType === ProductFieldDataType.SELECT) {
      const options = dto.options !== undefined ? dto.options : template.options;
      if (!Array.isArray(options) || options.length === 0) {
        throw new BadRequestException('Para campos de tipo SELECT, las opciones son obligatorias');
      }
    }

    return this.prisma.industryFieldTemplate.update({
      where: { id: fieldId },
      data: {
        ...(dto.label !== undefined && { label: dto.label.trim() }),
        ...(dto.dataType !== undefined && { dataType: dto.dataType }),
        ...(dto.required !== undefined && { required: dto.required }),
        ...(dto.options !== undefined && {
          options: targetDataType === ProductFieldDataType.SELECT ? dto.options : null,
        }),
        ...(dto.order !== undefined && { order: dto.order }),
        ...(dto.searchable !== undefined && { searchable: dto.searchable }),
        ...(dto.showInPos !== undefined && { showInPos: dto.showInPos }),
      },
    });
  }

  async removeFieldTemplate(industryId: string, fieldId: string) {
    await this.findOne(industryId);

    const template = await this.prisma.industryFieldTemplate.findUnique({
      where: { id: fieldId },
    });

    if (!template || template.industryId !== industryId) {
      throw new NotFoundException(`Plantilla de campo '${fieldId}' no encontrada`);
    }

    await this.prisma.industryFieldTemplate.delete({
      where: { id: fieldId },
    });

    return { message: 'Plantilla de campo eliminada exitosamente' };
  }
}
