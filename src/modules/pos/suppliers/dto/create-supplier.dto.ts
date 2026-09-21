import { IsString, IsOptional, IsEmail } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateSupplierDto {
  @SanitizeText()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  address?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;
}
