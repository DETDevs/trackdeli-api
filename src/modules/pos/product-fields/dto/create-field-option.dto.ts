import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateFieldOptionDto {
  @SanitizeText()
  @IsString()
  @IsNotEmpty({ message: 'La etiqueta de la opción es obligatoria' })
  @MaxLength(120, { message: 'La etiqueta no puede exceder 120 caracteres' })
  label: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
