import { IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BusinessType, PosVertical } from '@prisma/client';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class EncargadoDto {
  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;
}

export class CreateBusinessSuperAdminDto {
  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  industryId?: string;

  @IsString()
  @IsOptional()
  whatsappNumber?: string;

  @IsString()
  @IsOptional()
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

  @IsOptional()
  @IsBoolean()
  hasDelivery?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deliveryMonthlyFee?: number;

  @IsOptional()
  @IsBoolean()
  hasPOS?: boolean;

  @IsOptional()
  @IsEnum(PosVertical)
  posVertical?: PosVertical;

  @IsOptional()
  @IsNumber()
  @Min(0)
  posMonthlyFee?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxDevices?: number | null;

  @IsOptional()
  @IsBoolean()
  webAdminEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  webBillingEnabled?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  maxWebDevices?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  webBillingMonthlyUsd?: number | null;

  @IsOptional()
  @IsIn(['RESTAURANTE', 'TALLER', null])
  salonProfile?: 'RESTAURANTE' | 'TALLER' | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  trialHours?: number | null;

  @IsOptional()
  @IsBoolean()
  hasCarteraCobro?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  carteraMonthlyFee?: number;

  @IsOptional()
  @IsBoolean()
  hasCitas?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  citasMonthlyFee?: number;

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => EncargadoDto)
  encargado?: EncargadoDto;
}
