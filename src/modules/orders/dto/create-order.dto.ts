import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DeliveryPaymentStatus } from '@prisma/client';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateOrderDto {
  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  customerName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  customerPhone: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(300)
  destinationAddress?: string;

  @IsNumber()
  @IsNotEmpty()
  destinationLat: number;

  @IsNumber()
  @IsNotEmpty()
  destinationLng: number;

  @IsOptional()
  @SanitizeText()
  @IsString()
  description?: string;

  @IsEnum(DeliveryPaymentStatus)
  deliveryPaymentStatus: DeliveryPaymentStatus;

  @IsNumber()
  @IsOptional()
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(150)
  originBusinessName?: string;

  @IsString()
  @IsOptional()
  originBusinessClientId?: string;
}
