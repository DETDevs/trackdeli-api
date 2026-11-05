import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { CommercialPaymentKind, PaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateCommercialPaymentDto {
  @IsEnum(CommercialPaymentKind)
  @IsNotEmpty()
  kind: CommercialPaymentKind;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;

  @IsString()
  @IsOptional()
  referenceNumber?: string;

  @IsString()
  @IsOptional()
  paymentProofUrl?: string;

  @IsString()
  @IsOptional()
  paidAt?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  paidAmountNio?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  exchangeRate?: number;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;
}

