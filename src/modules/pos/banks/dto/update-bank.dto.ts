import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpdateBankDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(50, { message: 'El código no puede exceder 50 caracteres' })
  code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
