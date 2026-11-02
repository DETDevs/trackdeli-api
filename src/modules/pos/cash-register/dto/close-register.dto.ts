import { IsNumber, Min, IsOptional, IsString, IsArray, IsEnum, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';
import { ALLOWED_DISCREPANCY_REASONS } from '../constants/discrepancy-reasons.constant';

export class DenominationItemDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  value: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  qty: number;
}

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DenominationItemDto)
  denominations?: DenominationItemDto[];

  @IsOptional()
  @IsEnum(['DENOMINATIONS', 'TOTAL'])
  countMode?: 'DENOMINATIONS' | 'TOTAL';
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
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DenominationItemDto)
  denominations?: DenominationItemDto[];

  @IsOptional()
  @IsEnum(['DENOMINATIONS', 'TOTAL'])
  countMode?: 'DENOMINATIONS' | 'TOTAL';

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_DISCREPANCY_REASONS, {
    message: `discrepancyReason must be one of: ${ALLOWED_DISCREPANCY_REASONS.join(', ')}`,
  })
  discrepancyReason?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  discrepancyNote?: string;

  @IsOptional()
  @IsString()
  authorizerPin?: string;

  @IsOptional()
  @IsString()
  authorizerEmail?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;
}
