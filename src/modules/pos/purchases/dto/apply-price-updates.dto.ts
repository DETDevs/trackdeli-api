import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class PurchaseItemPriceUpdateDto {
  @IsString()
  productId: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  newPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  markupPct?: number;
}

export class ApplyPurchasePriceUpdatesDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemPriceUpdateDto)
  items?: PurchaseItemPriceUpdateDto[];
}
