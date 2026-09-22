import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class UpdateCustomerDto {
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'El teléfono debe ser una cadena de texto' })
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
  @IsBoolean({ message: 'isBlocked debe ser un booleano' })
  isBlocked?: boolean;
}
