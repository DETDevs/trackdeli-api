import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export const ALLOWED_COMMERCIAL_PAYMENT_KINDS = [
  'ADELANTO',
  'PRIMA',
  'CUOTA',
  'PAGO',
  'MANTENIMIENTO',
] as const;

export type CommercialPaymentKindInput = (typeof ALLOWED_COMMERCIAL_PAYMENT_KINDS)[number];

export class CreateCommercialPaymentDto {
  @IsIn(ALLOWED_COMMERCIAL_PAYMENT_KINDS)
  @IsNotEmpty()
  kind: CommercialPaymentKindInput;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsIn(['USD', 'NIO'])
  @IsOptional()
  currency?: 'USD' | 'NIO';

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

  @IsString()
  @IsOptional()
  installmentId?: string;

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
