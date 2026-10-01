import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProductFieldDataType } from '@prisma/client';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class UpdateFieldTemplateDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsEnum(ProductFieldDataType)
  dataType?: ProductFieldDataType;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];

  @IsOptional()
  @IsInt()
  order?: number;

  @IsOptional()
  @IsBoolean()
  searchable?: boolean;

  @IsOptional()
  @IsBoolean()
  showInPos?: boolean;
}
