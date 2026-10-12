import { IsString, MinLength, IsOptional, IsNumber, Min, IsBoolean, IsNotEmpty, IsIn } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';
import { ALLOWED_PRODUCT_UNITS } from '../product-unit.util';

export class CreateProductDto {
  @SanitizeText()
  @IsString()
  @MinLength(2)
  name: string;

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

  @IsNumber()
  @Min(0)
  price: number;

  @IsOptional()
  @IsNumber()
  wholesalePrice?: number | null;

  @IsOptional()
  @IsNumber()
  wholesaleMinQty?: number | null;

  @IsOptional()
  @IsNumber()
  wholesale_price?: number | null;

  @IsOptional()
  @IsNumber()
  wholesale_min_qty?: number | null;

  @IsOptional()
  @IsNumber()
  cost?: number;

  @IsNotEmpty({ message: 'La categoría es obligatoria' })
  @IsString({ message: 'El ID de la categoría debe ser una cadena de texto' })
  categoryId: string;

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsBoolean()
  trackStock?: boolean;

  @IsOptional()
  @IsBoolean()
  sendToKitchen?: boolean;

  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
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
  attributes?: Record<string, any>;

  @IsOptional()
  @IsIn(['PRODUCT', 'SERVICE'], { message: 'El tipo debe ser PRODUCT o SERVICE' })
  type?: 'PRODUCT' | 'SERVICE';
}
