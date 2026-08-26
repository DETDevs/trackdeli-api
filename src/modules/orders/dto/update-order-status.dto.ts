import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus, { message: 'status debe ser un valor válido de OrderStatus' })
  @IsNotEmpty()
  status: OrderStatus;

  @IsString()
  @IsOptional()
  notes?: string;
}
