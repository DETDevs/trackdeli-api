import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PosPaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateExpenseDto {
  @IsNotEmpty({ message: 'La categoría del gasto es obligatoria' })
  @IsString()
  categoryId: string;

  @IsNumber()
  @Min(0.01, { message: 'El monto debe ser mayor a cero' })
  amount: number;

  @IsNotEmpty({ message: 'La descripción del gasto es obligatoria' })
  @SanitizeText()
  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  expenseDate?: string;

  @IsOptional()
  @IsEnum(PosPaymentMethod)
  paymentMethod?: PosPaymentMethod = PosPaymentMethod.EFECTIVO;

  @IsOptional()
  @SanitizeText()
  @IsString()
  receiptNumber?: string;

  @IsOptional()
  @IsBoolean()
  deductFromCurrentShift?: boolean = false;
}
