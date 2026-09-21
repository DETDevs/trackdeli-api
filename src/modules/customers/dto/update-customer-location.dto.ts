import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class UpdateCustomerLocationDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @SanitizeText()
  @IsString()
  addressText?: string;

  @IsOptional()
  @IsBoolean()
  confirmedSameLocation?: boolean;
}
