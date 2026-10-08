import { IsEnum, IsString, IsOptional, IsNumber, Min } from 'class-validator';
import { StockMovementType } from '@prisma/client';

export class AdjustStockDto {
  @IsNumber()
  quantity: number;

  @IsEnum(StockMovementType)
  type: StockMovementType;

  @IsString()
  concept: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsString()
  reference?: string;
}
