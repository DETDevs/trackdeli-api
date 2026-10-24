import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { PosPaymentMethod } from '@prisma/client';

export class GetExpensesDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsEnum(PosPaymentMethod)
  paymentMethod?: PosPaymentMethod;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true || value === '1')
  @IsBoolean()
  includeVoided?: boolean = false;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }) => Math.max(1, Number(value) || 1))
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => Math.min(100, Math.max(1, Number(value) || 20)))
  pageSize?: number = 20;

  @IsOptional()
  @IsString()
  businessId?: string;
}
