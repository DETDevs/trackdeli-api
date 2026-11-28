import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateRouteSellerDto {
  @SanitizeText()
  @IsString({ message: 'El nombre debe ser texto.' })
  @IsNotEmpty({ message: 'El nombre del vendedor es obligatorio.' })
  @MaxLength(100, { message: 'El nombre no puede superar los 100 caracteres.' })
  name: string;

  @IsEmail({}, { message: 'El correo electrónico no es válido.' })
  @IsNotEmpty({ message: 'El correo electrónico es obligatorio.' })
  @MaxLength(150, { message: 'El correo no puede superar los 150 caracteres.' })
  email: string;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El teléfono debe ser texto.' })
  @MaxLength(20, { message: 'El teléfono no puede superar los 20 caracteres.' })
  phone?: string;

  @IsOptional()
  @IsString({ message: 'La contraseña debe ser texto.' })
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres.' })
  @MaxLength(100, { message: 'La contraseña no puede superar los 100 caracteres.' })
  password?: string;
}
