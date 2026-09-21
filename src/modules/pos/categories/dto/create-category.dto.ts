import { IsString, MinLength, IsOptional } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateCategoryDto {
  @SanitizeText()
  @IsString()
  @MinLength(2)
  name: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string;
}
