import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateExpenseCategoryDto {
  @IsNotEmpty({ message: 'El nombre de la categoría es obligatorio' })
  @SanitizeText()
  @IsString()
  name: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  color?: string;
}
