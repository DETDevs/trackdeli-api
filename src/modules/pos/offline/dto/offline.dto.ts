import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PosPaymentMethod } from "@prisma/client";
import { CreateSaleItemDto } from "../../sales/dto/create-sale.dto";

export class RegisterTerminalDto {
  @IsString()
  @IsNotEmpty()
  deviceIdentifier: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  terminalType?: string;
}

export class UpdateTerminalStatusDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  hasPendingOfflineSales?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  pendingSalesCount?: number;
}

export class SyncOfflineSaleItemDto {
  @IsString()
  @IsNotEmpty()
  clientGeneratedId: string;

  @IsString()
  @IsNotEmpty()
  occurredAt: string;

  @IsOptional()
  @IsString()
  cashRegisterId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items: CreateSaleItemDto[];

  @IsEnum(PosPaymentMethod)
  paymentMethod: PosPaymentMethod;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountPaid: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

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
  customerRuc?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  sellerId?: string;

  @IsOptional()
  @IsString()
  sellerName?: string;

  @IsOptional()
  @IsString()
  presaleTicketId?: string;

  // Canales de venta (221a)
  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @IsString()
  deliveryAddress?: string;

  @IsOptional()
  @IsString()
  deliveryPhone?: string;

  @IsOptional()
  @IsString()
  deliveryReference?: string;

  @IsOptional()
  @IsString()
  deliveryDriverId?: string;

  @IsOptional()
  @IsString()
  deliveryDriverName?: string;

  @IsOptional()
  @IsString()
  pedidosYaOrderNumber?: string;

  @IsOptional()
  @IsString()
  pedidosYaPaymentMode?: string;
}

export class SyncOfflineBatchDto {
  @IsString()
  @IsNotEmpty()
  deviceIdentifier: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncOfflineSaleItemDto)
  sales: SyncOfflineSaleItemDto[];
}

export class ResolveDiscrepancyDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

