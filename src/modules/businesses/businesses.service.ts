import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { BusinessResponseDto } from './dto/business-response.dto';
import { Business } from '@prisma/client';

@Injectable()
export class BusinessesService {
  constructor(private readonly prisma: PrismaService) {}

  private toResponseDto(business: Business): BusinessResponseDto {
    return {
      id: business.id,
      name: business.name,
      type: business.type,
      logoUrl: business.logoUrl,
      defaultGeofenceRadiusM: business.defaultGeofenceRadiusM,
      createdAt: business.createdAt,
    };
  }

  async findOne(id: string): Promise<BusinessResponseDto> {
    const business = await this.prisma.business.findUnique({
      where: { id },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    return this.toResponseDto(business);
  }

  async update(id: string, dto: UpdateBusinessDto): Promise<BusinessResponseDto> {
    const business = await this.prisma.business.findUnique({
      where: { id },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const updated = await this.prisma.business.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        ...(dto.defaultGeofenceRadiusM !== undefined && { defaultGeofenceRadiusM: dto.defaultGeofenceRadiusM }),
      },
    });

    return this.toResponseDto(updated);
  }
}
