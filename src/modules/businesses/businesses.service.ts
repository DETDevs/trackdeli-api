import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { BusinessResponseDto } from './dto/business-response.dto';
import { Business } from '@prisma/client';

@Injectable()
export class BusinessesService {
  private readonly logger = new Logger(BusinessesService.name);

  constructor(private readonly prisma: PrismaService) {}

  private toResponseDto(business: Business): BusinessResponseDto {
    return {
      id: business.id,
      name: business.name,
      type: business.type,
      logoUrl: business.logoUrl,
      defaultGeofenceRadiusM: business.defaultGeofenceRadiusM,
      latitude: business.latitude,
      longitude: business.longitude,
      isActive: business.isActive,
      businessType: business.businessType,
      commissionRate: business.commissionRate,
      altCommissionRate: business.altCommissionRate,
      altCommissionDistanceKm: business.altCommissionDistanceKm,
      dispatchTimeoutMin: business.dispatchTimeoutMin,
      hasTrackDeli: business.hasTrackDeli,
      hasPOS: business.hasPOS,
      pricingModel: business.pricingModel,
      baseRate: business.baseRate,
      ratePerKm: business.ratePerKm,
      freeZoneKm: business.freeZoneKm,
      minRate: business.minRate,
      maxRate: business.maxRate,
      pricingZones: (business as any).pricingZones ?? null,
      whatsappNumber: business.whatsappNumber ?? null,
      whatsappDisplay: business.whatsappDisplay ?? null,
      taxRate: business.taxRate,
      currency: business.currency,
      invoicePrefix: business.invoicePrefix,
      invoiceCounter: business.invoiceCounter,
      posAddress: business.posAddress ?? null,
      posPhone: business.posPhone ?? null,
      posFooter: business.posFooter ?? null,
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
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
        ...(dto.pricingModel !== undefined && { pricingModel: dto.pricingModel }),
        ...(dto.baseRate !== undefined && { baseRate: dto.baseRate }),
        ...(dto.ratePerKm !== undefined && { ratePerKm: dto.ratePerKm }),
        ...(dto.freeZoneKm !== undefined && { freeZoneKm: dto.freeZoneKm }),
        ...(dto.minRate !== undefined && { minRate: dto.minRate }),
        ...(dto.maxRate !== undefined && { maxRate: dto.maxRate }),
        ...(dto.pricingZones !== undefined && { pricingZones: dto.pricingZones as any }),
        ...(dto.whatsappNumber !== undefined && { whatsappNumber: dto.whatsappNumber }),
        ...(dto.whatsappDisplay !== undefined && { whatsappDisplay: dto.whatsappDisplay }),
        ...(dto.businessType !== undefined && { businessType: dto.businessType }),
        ...(dto.commissionRate !== undefined && { commissionRate: dto.commissionRate }),
        ...(dto.altCommissionRate !== undefined && { altCommissionRate: dto.altCommissionRate }),
        ...(dto.altCommissionDistanceKm !== undefined && { altCommissionDistanceKm: dto.altCommissionDistanceKm }),
        ...(dto.dispatchTimeoutMin !== undefined && { dispatchTimeoutMin: dto.dispatchTimeoutMin }),
      },
    });

    if (dto.latitude !== undefined || dto.longitude !== undefined) {
      this.logger.log(`[update] OK businessId=${id} ubicación actualizada a lat=${dto.latitude}, lng=${dto.longitude}`);
    } else {
      this.logger.log(`[update] OK businessId=${id}`);
    }

    return this.toResponseDto(updated);
  }
}
