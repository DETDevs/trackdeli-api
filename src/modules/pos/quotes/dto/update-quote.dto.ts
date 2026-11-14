import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';
import {
  MAX_QUOTE_VALIDITY_DAYS,
  MIN_QUOTE_VALIDITY_DAYS,
} from '../pos-quotes.constants';
import { CreateQuoteItemDto } from './create-quote.dto';

export class UpdateQuoteDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'La proforma debe contener al menos una línea' })
  @ValidateNested({ each: true })
  @Type(() => CreateQuoteItemDto)
  items?: CreateQuoteItemDto[];

  @IsOptional()
  @IsString()
  customerId?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(120)
  customerName?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(30)
  customerPhone?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(30)
  customerRuc?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(300)
  customerAddress?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(120)
  vehicleInfo?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_QUOTE_VALIDITY_DAYS)
  @Max(MAX_QUOTE_VALIDITY_DAYS)
  validityDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  approvalToken?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString()
  conditions?: string | null;
}

