import {
  IsEnum,
  IsInt,
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
  @IsInt()
  qtyDelta?: number;

  @IsOptional()
  @IsInt()
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
