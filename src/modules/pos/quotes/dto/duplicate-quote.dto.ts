import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  MAX_QUOTE_VALIDITY_DAYS,
  MIN_QUOTE_VALIDITY_DAYS,
} from '../pos-quotes.constants';

export class DuplicateQuoteDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_QUOTE_VALIDITY_DAYS)
  @Max(MAX_QUOTE_VALIDITY_DAYS)
  validityDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientRequestId?: string;
}

