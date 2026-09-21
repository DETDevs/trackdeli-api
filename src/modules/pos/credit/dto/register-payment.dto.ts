import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PosPaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class RegisterCreditPaymentDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.01, { message: 'El monto a abonar debe ser mayor a 0' })
  amount: number;

  @IsEnum(PosPaymentMethod, { message: 'Método de pago inválido' })
  paymentMethod: PosPaymentMethod;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;
}
