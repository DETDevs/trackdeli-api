import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class UpdateCustomerDto {
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'El teléfono debe ser una cadena de texto' })
  @MaxLength(30, { message: 'El teléfono no puede superar 30 caracteres' })
  @Matches(/^[0-9+ ()-]{7,25}$/, { message: 'El formato del teléfono no es válido' })
  phone?: string;

  @IsOptional()
  @IsString({ message: 'El correo debe ser una cadena de texto' })
  email?: string;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'Las notas deben ser una cadena de texto' })
  notes?: string;

  @IsOptional()
  @IsString({ message: 'El RUC debe ser una cadena de texto' })
  ruc?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El límite de crédito debe ser un número' })
  @Min(0, { message: 'El límite de crédito no puede ser negativo' })
  creditLimit?: number;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'La dirección debe ser una cadena de texto' })
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'La latitud debe ser un número' })
  latitude?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'La longitud debe ser un número' })
  longitude?: number | null;

  @IsOptional()
  @IsBoolean({ message: 'isBlocked debe ser un booleano' })
  isBlocked?: boolean;
}

