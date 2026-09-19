import { IsBoolean, IsEmail, IsEnum, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BusinessType, PosVertical } from '@prisma/client';

export class EncargadoDto {
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
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  type?: string;

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
