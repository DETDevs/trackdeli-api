import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class UpdateUserDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
