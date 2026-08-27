import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class OrdersMetricsQueryDto {
  @IsString()
  @IsOptional()
  businessId?: string;

  @IsString()
  @IsOptional()
  riderId?: string;

  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;

  @IsEnum(OrderStatus)
  @IsOptional()
  status?: OrderStatus;
}
