import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';

export class VariantAxisInputDto {
  @IsString({ message: 'La clave del eje debe ser una cadena de texto.' })
  @IsNotEmpty({ message: 'La clave del eje es obligatoria.' })
  key: string;

  @IsArray({ message: 'Los valores del eje deben ser una lista.' })
  @ArrayNotEmpty({ message: 'Cada eje debe incluir al menos un valor.' })
  @IsString({ each: true, message: 'Cada valor del eje debe ser texto.' })
  values: string[];
}

export class GenerateVariantsDto {
  @IsArray({ message: 'Debés enviar la lista de ejes para generar variantes.' })
  @ArrayNotEmpty({ message: 'Debés seleccionar al menos un eje para generar variantes.' })
  @ValidateNested({ each: true })
  @Type(() => VariantAxisInputDto)
  axes: VariantAxisInputDto[];
}
