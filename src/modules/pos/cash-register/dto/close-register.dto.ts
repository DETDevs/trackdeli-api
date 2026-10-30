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
  CARD?: number | any;

  @IsOptional()
  TRANSFER?: number | any;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  OTHER?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  CASH_USD?: number;

  @IsOptional()
  cardByBank?: any;

  @IsOptional()
  transferByBank?: any;
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
  closingCashUsd?: number;

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
