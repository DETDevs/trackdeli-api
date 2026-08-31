import { IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, IsNumber, IsEnum, Matches } from 'class-validator';
import { BusinessType, PricingModel } from '@prisma/client';

export class UpdateBusinessDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  type?: string;

  @IsUrl()
  @IsOptional()
  logoUrl?: string;

  @IsInt()
  @IsOptional()
  @Min(30)
  @Max(500)
  defaultGeofenceRadiusM?: number;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @IsEnum(PricingModel)
  pricingModel?: PricingModel;

  @IsOptional()
  @IsNumber()
  @Min(0)
  baseRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  ratePerKm?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  freeZoneKm?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxRate?: number;

  @IsOptional()
  pricingZones?: Array<{ id?: string; name: string; price: number }>;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{10,15}$/, {
    message: 'El número de WhatsApp debe tener entre 10 y 15 dígitos, sin espacios ni símbolos',
  })
  whatsappNumber?: string;

  @IsOptional()
  @IsString()
  whatsappDisplay?: string;

  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  altCommissionRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  altCommissionDistanceKm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  dispatchTimeoutMin?: number;
}
