import { IsArray, IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class ReturnItemInputDto {
  @IsNotEmpty({ message: 'saleItemId es obligatorio' })
  @IsString()
  saleItemId: string;

  @IsNotEmpty({ message: 'qty es obligatoria' })
  @IsNumber()
  @IsPositive({ message: 'qty debe ser mayor a 0' })
  qty: number;

  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}

export class CreateReturnDto {
  @IsArray({ message: 'items debe ser un arreglo' })
  @ValidateNested({ each: true })
  @Type(() => ReturnItemInputDto)
  items: ReturnItemInputDto[];

  @IsNotEmpty({ message: 'El motivo es obligatorio' })
  @SanitizeText()
  @IsString()
  reason: string; // DEFECTIVE | WRONG_ITEM | CUSTOMER_CHANGED_MIND | PRICING_ERROR | OTHER

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;

  @IsNotEmpty({ message: 'El método de reembolso es obligatorio' })
  @IsString()
  refundMethod: string; // EFECTIVO, TARJETA, TRANSFERENCIA, CREDITO, OTRO

  @IsOptional()
  @IsString()
  approvalToken?: string;
}
