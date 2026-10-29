import { IsString, MinLength, IsOptional, IsBoolean } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpdateCategoryDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
