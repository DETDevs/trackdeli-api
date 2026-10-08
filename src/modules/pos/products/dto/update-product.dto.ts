import { IsString, IsOptional, IsNumber, Min, IsBoolean, IsNotEmpty, IsIn } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';
import { ALLOWED_PRODUCT_UNITS } from '../product-unit.util';

export class UpdateProductDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  name?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_PRODUCT_UNITS as any, {
    message: 'La unidad de medida debe ser una de: UND, LT, GAL, KG, LB',
  })
  unit?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsNotEmpty({ message: 'La categoría no puede estar vacía' })
  @IsString({ message: 'El ID de la categoría debe ser una cadena de texto' })
  categoryId?: string;

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsBoolean()
  trackStock?: boolean;

  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @IsOptional()
  @IsNumber()
  stock?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxStock?: number;

  @IsOptional()
  @IsBoolean()
  taxIncluded?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  attributes?: Record<string, any>;
}
