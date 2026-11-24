import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CommercialEquipmentStatus,
  CommercialEquipmentType,
} from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateCommercialEquipmentDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsEnum(CommercialEquipmentType)
  @IsOptional()
  equipmentType?: CommercialEquipmentType;

  @IsOptional()
  @SanitizeText()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @SanitizeText()
  brand?: string;

  @IsOptional()
  @IsString()
  @SanitizeText()
  model?: string;

  @IsOptional()
  @IsString()
  @SanitizeText()
  serialNumber?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  price?: number | null;

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
