import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreatePresaleTicketItemDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsOptional()
  @IsString()
  productName?: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  listPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsBoolean()
  taxable?: boolean;
}

export class CreatePresaleTicketDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePresaleTicketItemDto)
  items: CreatePresaleTicketItemDto[];

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  customerPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  clientRequestId?: string;

  @IsOptional()
  @IsString()
  sellerDeviceId?: string;
}
