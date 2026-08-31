import { IsEmail, IsEnum, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BusinessType } from '@prisma/client';

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

  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => EncargadoDto)
  encargado?: EncargadoDto;
}
