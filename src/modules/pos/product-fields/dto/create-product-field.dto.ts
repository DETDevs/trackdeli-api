import { IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProductFieldDataType } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateProductFieldDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(50)
  key?: string;

  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  @IsEnum(ProductFieldDataType)
  dataType: ProductFieldDataType;

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
