import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateSpecialistDto {
  @SanitizeText()
  @IsNotEmpty({ message: 'El nombre del especialista es obligatorio' })
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @MaxLength(150, { message: 'El nombre no puede exceder 150 caracteres' })
  name: string;

  @IsOptional()
  @IsString({ message: 'El professionId debe ser una cadena de texto' })
  professionId?: string;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'La especialidad debe ser una cadena de texto' })
  @MaxLength(150, { message: 'La especialidad no puede exceder 150 caracteres' })
  specialty?: string;

  @IsOptional()
  @IsBoolean({ message: 'El campo activo debe ser booleano' })
  active?: boolean;
}

export class UpdateSpecialistDto {
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @MaxLength(150, { message: 'El nombre no puede exceder 150 caracteres' })
  name?: string;

  @IsOptional()
  professionId?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'La especialidad debe ser una cadena de texto' })
  @MaxLength(150, { message: 'La especialidad no puede exceder 150 caracteres' })
  specialty?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'El campo activo debe ser booleano' })
  active?: boolean;
}
