import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class AddSubAccountDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  splitVersion?: number;
}
