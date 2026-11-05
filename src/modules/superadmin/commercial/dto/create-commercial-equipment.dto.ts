import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import {
  CommercialEquipmentStatus,
  CommercialEquipmentType,
} from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateCommercialEquipmentDto {
  @IsEnum(CommercialEquipmentType)
  @IsNotEmpty()
  equipmentType: CommercialEquipmentType;

  @IsOptional()
  @SanitizeText()
  @IsString()
  description?: string;

  @IsString()
  @IsNotEmpty()
  @SanitizeText()
  brand: string;

  @IsString()
  @IsNotEmpty()
  @SanitizeText()
  model: string;

  @IsOptional()
  @IsString()
  @SanitizeText()
  serialNumber?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  price?: number;

  @IsEnum(CommercialEquipmentStatus)
  @IsOptional()
  status?: CommercialEquipmentStatus;

  @IsString()
  @IsOptional()
  deliveredAt?: string;

  @IsString()
  @IsOptional()
  warrantyEndsAt?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;
}

