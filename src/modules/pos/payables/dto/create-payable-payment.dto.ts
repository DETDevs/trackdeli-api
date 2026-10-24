import { IsNumber, Min, IsOptional, IsString, IsEnum, IsBoolean } from 'class-validator';
import { PosPaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreatePayablePaymentDto {
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsEnum(PosPaymentMethod)
  paymentMethod?: PosPaymentMethod = PosPaymentMethod.EFECTIVO;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  deductFromCurrentShift?: boolean = false;
}
