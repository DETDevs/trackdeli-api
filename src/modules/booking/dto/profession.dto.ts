import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateProfessionDto {
  @SanitizeText()
  @IsNotEmpty({ message: 'El nombre de la profesión o especialidad es obligatorio' })
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @MaxLength(60, { message: 'El nombre no puede exceder 60 caracteres' })
  name: string;

  @IsOptional()
  @IsBoolean({ message: 'El campo activo debe ser booleano' })
  active?: boolean;
}

export class UpdateProfessionDto {
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @MaxLength(60, { message: 'El nombre no puede exceder 60 caracteres' })
  name?: string;

  @IsOptional()
  @IsBoolean({ message: 'El campo activo debe ser booleano' })
  active?: boolean;
}
