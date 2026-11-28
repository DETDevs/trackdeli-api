import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpdateRouteSellerDto {
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El nombre debe ser texto.' })
  @MaxLength(100, { message: 'El nombre no puede superar los 100 caracteres.' })
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo electrónico no es válido.' })
  @MaxLength(150, { message: 'El correo no puede superar los 150 caracteres.' })
  email?: string;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El teléfono debe ser texto.' })
  @MaxLength(20, { message: 'El teléfono no puede superar los 20 caracteres.' })
  phone?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'El estado activo debe ser verdadero o falso.' })
  isActive?: boolean;

  @IsOptional()
  @IsString({ message: 'La contraseña debe ser texto.' })
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres.' })
  @MaxLength(100, { message: 'La contraseña no puede superar los 100 caracteres.' })
  password?: string;
}
