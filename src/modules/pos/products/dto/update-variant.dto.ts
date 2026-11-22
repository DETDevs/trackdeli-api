import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateVariantDto {
  @IsOptional()
  @IsNumber({}, { message: 'El precio debe ser un número válido.' })
  @Min(0, { message: 'El precio no puede ser negativo.' })
  price?: number;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({}, { message: 'El costo debe ser un número válido.' })
  @Min(0, { message: 'El costo no puede ser negativo.' })
  cost?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'El código de barras debe ser texto.' })
  @MaxLength(50, { message: 'El código de barras no puede superar 50 caracteres.' })
  barcode?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'El SKU debe ser texto.' })
  @MaxLength(50, { message: 'El SKU no puede superar 50 caracteres.' })
  sku?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'isActive debe ser booleano.' })
  isActive?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: 'La URL de la foto debe ser texto.' })
  @MaxLength(500, { message: 'La URL de la foto no puede superar 500 caracteres.' })
  imageUrl?: string | null;
}
