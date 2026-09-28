import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PosPaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CheckoutAppointmentDto {
  @IsEnum(PosPaymentMethod, { message: 'Método de pago inválido' })
  paymentMethod: PosPaymentMethod;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amountPaid?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  creditDueDate?: string;

  @IsOptional()
  @IsString()
  cashRegisterId?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(300)
  notes?: string;
}
