import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MembershipStatus, PaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateMembershipDto {
  @IsString()
  @IsNotEmpty()
  businessId: string;

  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @IsDateString()
  @IsNotEmpty()
  endDate: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod;

  @IsDateString()
  @IsOptional()
  paidAt?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;

  @IsEnum(MembershipStatus)
  @IsOptional()
  status?: MembershipStatus;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  businessProductSubscriptionIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  businessProductSubscriptionId?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MembershipProductItemDto)
  @IsOptional()
  products?: MembershipProductItemDto[];
}

export class MembershipProductItemDto {
  @IsString()
  @IsNotEmpty()
  businessProductSubscriptionId: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  amountAttributed?: number;
}
