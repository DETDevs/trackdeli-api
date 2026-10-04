import { IsNumber, Min, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CountedBreakdownDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  CASH?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  CARD?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  TRANSFER?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  OTHER?: number;
}

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
  counted?: CountedBreakdownDto;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
