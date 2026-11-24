import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CommercialPaymentType } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';
import { CreateCommercialEquipmentDto } from './create-commercial-equipment.dto';
import { CreateCommercialPaymentDto } from './create-commercial-payment.dto';

export const ALLOWED_SALE_MODALITIES = [
  'MEMBRESIA',
  'MEMBRESIA_MENSUAL',
  'SOLO_SISTEMA',
  'PAGO_UNICO_SISTEMA',
  'COMBO_COMPLETO',
  'COMBO_PARCIAL',
] as const;

export type SaleModalityInput = (typeof ALLOWED_SALE_MODALITIES)[number];

export class UpsertCommercialAgreementDto {
  @IsIn(ALLOWED_SALE_MODALITIES)
  @IsOptional()
  saleModality?: SaleModalityInput;

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

  @IsIn(['USD', 'NIO'])
  @IsOptional()
  currency?: 'USD' | 'NIO';

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

  @IsString()
  @IsOptional()
  saleDate?: string;

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCommercialEquipmentDto)
  equipment?: CreateCommercialEquipmentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateCommercialPaymentDto)
  initialPayment?: CreateCommercialPaymentDto;
}
