import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { PosPaymentMethod } from '@prisma/client';
import { PaymentDto, CreditPlanDto } from '../../sales/dto/create-sale.dto';

export class ChargePresaleTicketDto {
  @IsOptional()
  @IsEnum(PosPaymentMethod)
  paymentMethod?: PosPaymentMethod;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountPaid?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentDto)
  payments?: PaymentDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreditPlanDto)
  creditPlan?: CreditPlanDto;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  customerPhone?: string;

  @IsOptional()
  @IsString()
  customerRuc?: string;

  @IsOptional()
  @IsString()
  cashRegisterId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  approvalToken?: string;
}
