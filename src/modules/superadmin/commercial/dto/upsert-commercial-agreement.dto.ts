import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  CommercialPaymentType,
  CommercialSaleModality,
} from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpsertCommercialAgreementDto {
  @IsEnum(CommercialSaleModality)
  @IsOptional()
  saleModality?: CommercialSaleModality;

  @IsEnum(CommercialPaymentType)
  @IsOptional()
  paymentType?: CommercialPaymentType;

  @IsNumber()
  @Min(0)
  @IsOptional()
  totalPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  downPayment?: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  installmentsCount?: number;

  @IsString()
  @IsOptional()
  firstInstallmentDate?: string;

  @IsInt()
  @Min(0)
  @Max(30)
  @IsOptional()
  graceDays?: number;

  @IsString()
  @IsOptional()
  activatedAt?: string;

  @IsInt()
  @Min(0)
  @Max(60)
  @IsOptional()
  maintenanceFreeMonths?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  maintenanceFeeNio?: number;

  @IsString()
  @IsOptional()
  installationDoneAt?: string;

  @IsString()
  @IsOptional()
  trainingDoneAt?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;
}
