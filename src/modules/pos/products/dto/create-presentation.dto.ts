import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreatePresentationDto {
  @SanitizeText()
  @IsString({ message: 'El nombre de la presentación debe ser texto.' })
  @IsNotEmpty({ message: 'El nombre de la presentación es obligatorio.' })
  @MaxLength(100, { message: 'El nombre de la presentación no puede superar los 100 caracteres.' })
  name: string;

  @Type(() => Number)
  @IsNumber({}, { message: 'El factor de conversión debe ser un número.' })
  @Min(0.001, { message: 'El factor de conversión debe ser mayor que 0.' })
  factor: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'El precio de la presentación debe ser un número.' })
  @Min(0, { message: 'El precio no puede ser negativo.' })
  price: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El precio de etiqueta debe ser un número.' })
  @Min(0, { message: 'El precio de etiqueta no puede ser negativo.' })
  listPrice?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El precio por mayor debe ser un número.' })
  @Min(0, { message: 'El precio por mayor no puede ser negativo.' })
  wholesalePrice?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'La cantidad mínima por mayor debe ser un número.' })
  @Min(2, { message: 'La cantidad mínima por mayor debe ser al menos 2.' })
  wholesaleMinQty?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'El código de barras no puede superar los 50 caracteres.' })
  barcode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'El SKU no puede superar los 50 caracteres.' })
  sku?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El costo sugerido debe ser un número.' })
  @Min(0, { message: 'El costo sugerido no puede ser negativo.' })
  cost?: number | null;

  @IsOptional()
  @IsBoolean()
  isDefaultPurchase?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}
