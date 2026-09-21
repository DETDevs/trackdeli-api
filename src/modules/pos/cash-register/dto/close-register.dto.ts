import { IsNumber, Min, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CloseCashRegisterDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  closingCash?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  actualAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;
}
