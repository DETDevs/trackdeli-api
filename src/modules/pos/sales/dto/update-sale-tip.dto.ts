import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateSaleTipDto {
  @Type(() => Number)
  @IsNumber({}, { message: 'El monto de la propina debe ser un número.' })
  @Min(0, { message: 'El monto de la propina no puede ser negativo.' })
  amount: number;

  @IsOptional()
  @IsString({ message: 'El método de pago debe ser texto.' })
  @IsIn(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA'], {
    message: 'Método de pago de propina inválido (usa EFECTIVO, TARJETA o TRANSFERENCIA).',
  })
  paymentMethod?: 'EFECTIVO' | 'TARJETA' | 'TRANSFERENCIA';

  @IsOptional()
  @IsString({ message: 'La moneda debe ser texto.' })
  @IsIn(['NIO', 'USD'], { message: 'Moneda de propina inválida (usa NIO o USD).' })
  currency?: 'NIO' | 'USD';

  @IsOptional()
  @IsString()
  bankId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string | null;

  @IsString({ message: 'El motivo es obligatorio.' })
  @IsNotEmpty({ message: 'El motivo es obligatorio para modificar la propina.' })
  @MaxLength(500, { message: 'El motivo no puede superar los 500 caracteres.' })
  reason: string;
}
