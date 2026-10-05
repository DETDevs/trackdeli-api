import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PosPaymentMethod } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class SettleCreditStatementDto {
  @IsNotEmpty({ message: 'El método de pago es obligatorio' })
  @IsEnum(PosPaymentMethod, { message: 'Método de pago inválido' })
  method: PosPaymentMethod;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'La referencia debe ser una cadena de texto' })
  reference?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El monto debe ser un número' })
  @Min(0.01, { message: 'El monto debe ser mayor a 0' })
  amount?: number;
}
