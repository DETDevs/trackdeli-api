import { IsOptional, IsString, IsEnum, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { PayableAccountStatus } from '@prisma/client';

export class GetPayablesDto {
  @IsOptional()
  @IsEnum(PayableAccountStatus)
  status?: PayableAccountStatus;

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true || value === '1')
  @IsBoolean()
  onlyOverdue?: boolean;

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
