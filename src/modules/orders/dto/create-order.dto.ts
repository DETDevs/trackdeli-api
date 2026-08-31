import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DeliveryPaymentStatus } from '@prisma/client';

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  customerName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  customerPhone: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  destinationAddress?: string;

  @IsNumber()
  @IsNotEmpty()
  destinationLat: number;

  @IsNumber()
  @IsNotEmpty()
  destinationLng: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(DeliveryPaymentStatus)
  deliveryPaymentStatus: DeliveryPaymentStatus;

  @IsNumber()
  @IsOptional()
  @Min(0)
  deliveryFee?: number;

  @IsString()
  @IsOptional()
  @MaxLength(150)
  originBusinessName?: string;

  @IsString()
  @IsOptional()
  originBusinessClientId?: string;
}
