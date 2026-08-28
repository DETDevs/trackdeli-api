import {
  IsArray, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PosPaymentMethod } from "@prisma/client";

export class CreateSaleItemDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsString()
  productName: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsNumber()
  @Min(0)
  unitPrice: number;

  @IsNumber()
  @Min(0.01)
  quantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discount?: number;
}

export class CreateSaleDto {
  @IsOptional()
  @IsString()
  cashRegisterId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items: CreateSaleItemDto[];

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  customerPhone?: string;

  @IsOptional()
  @IsString()
  customerRuc?: string;

  @IsEnum(PosPaymentMethod)
  paymentMethod: PosPaymentMethod;

  @IsNumber()
  @Min(0)
  amountPaid: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
