import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePedidosYaSettlementDto {
  @IsNotEmpty({ message: 'La fecha del depósito es obligatoria' })
  @IsString({ message: 'La fecha debe ser una cadena ISO' })
  depositDate: string;

  @Type(() => Number)
  @IsNumber({}, { message: 'El monto depositado debe ser un número' })
  @Min(0, { message: 'El monto depositado no puede ser negativo' })
  depositAmount: number;

  @IsOptional()
  @IsString({ message: 'bankId debe ser una cadena de texto' })
  bankId?: string;

  @IsOptional()
  @IsString({ message: 'La referencia debe ser una cadena de texto' })
  reference?: string;

  @IsOptional()
  @IsString({ message: 'Las notas deben ser una cadena de texto' })
  notes?: string;

  @IsArray({ message: 'saleIds debe ser un arreglo de IDs' })
  @IsNotEmpty({ message: 'Debe incluir al menos un pedido para liquidar' })
  saleIds: string[];
}

export class PedidosYaSettlementQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  status?: string; // 'PENDIENTE' | 'LIQUIDADO' | 'ALL'
}
