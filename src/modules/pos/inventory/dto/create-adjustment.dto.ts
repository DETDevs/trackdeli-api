import {
  IsEnum,
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { InventoryAdjustmentType } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateAdjustmentDto {
  @IsNotEmpty()
  @IsString()
  productId: string;

  @IsEnum(InventoryAdjustmentType)
  type: InventoryAdjustmentType;

  @IsOptional()
  @IsNumber()
  qtyDelta?: number;

  @IsOptional()
  @IsNumber()
  countedQty?: number;

  @IsNotEmpty({ message: 'El motivo del ajuste es obligatorio' })
  @SanitizeText()
  @IsString()
  reason: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  approvalToken?: string;
}
