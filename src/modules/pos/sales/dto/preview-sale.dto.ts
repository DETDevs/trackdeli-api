import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PreviewSaleItemDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  presentationId?: string;

  @IsOptional()
  @IsString()
  productName?: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  subtotal?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  listPrice?: number;

  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @IsOptional()
  @IsString()
  origin?: string;

  @IsOptional()
  @IsString()
  priceTier?: string;
}

export class PreviewSaleDto {
  @IsOptional()
  @IsBoolean()
  isSplitSale?: boolean;

  @IsArray()
  @ArrayNotEmpty({ message: 'Debés enviar al menos un ítem para calcular la vista previa.' })
  @ValidateNested({ each: true })
  @Type(() => PreviewSaleItemDto)
  items: PreviewSaleItemDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @IsBoolean()
  applyPromotions?: boolean;

  @IsOptional()
  @IsString()
  presaleTicketId?: string;

  @IsOptional()
  @IsString()
  quoteId?: string;
}
