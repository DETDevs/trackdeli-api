import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpdateFieldOptionDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(120, { message: 'La etiqueta no puede exceder 120 caracteres' })
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
