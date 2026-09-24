import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';
import { SLUG_REGEX } from '../../../common/utils/slug.util';

export class UpdateBusinessSlugDto {
  @IsNotEmpty({ message: 'El slug no puede estar vacío' })
  @IsString({ message: 'El slug debe ser una cadena de texto' })
  @Length(3, 50, { message: 'El slug debe tener entre 3 y 50 caracteres' })
  @Matches(SLUG_REGEX, {
    message:
      'El slug solo puede contener letras minúsculas, números y guiones medios simples (sin espacios ni caracteres especiales)',
  })
  slug: string;
}
