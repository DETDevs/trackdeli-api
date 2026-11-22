import { IsString, IsNotEmpty, IsBoolean, IsOptional, IsNumber, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateUnitDto {
  @IsString()
  @IsNotEmpty({ message: 'El código de la unidad es obligatorio.' })
  @MaxLength(10, { message: 'El código de la unidad no puede superar los 10 caracteres.' })
  code: string;

  @IsString()
  @IsNotEmpty({ message: 'El nombre de la unidad es obligatorio.' })
  @MaxLength(100, { message: 'El nombre de la unidad no puede superar los 100 caracteres.' })
  name: string;

  @IsBoolean({ message: 'Indicá si la unidad acepta decimales.' })
  allowsDecimals: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  sortOrder?: number;
}
