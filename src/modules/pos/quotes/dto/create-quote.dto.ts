import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
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

export class CreateQuoteItemDto {
  @IsOptional()
  @IsString()
  productId?: string | null;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(200)
  productName?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(10)
  unit?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class CreateQuoteDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'La proforma debe contener al menos una línea' })
  @ValidateNested({ each: true })
  @Type(() => CreateQuoteItemDto)
  items: CreateQuoteItemDto[];

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

  @IsOptional()
  @IsIn(['DRAFT', 'SENT'])
  status?: 'DRAFT' | 'SENT';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientRequestId?: string;
}

