import {
  IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PosPaymentMethod } from "@prisma/client";
import { SanitizeText } from "../../../../common/decorators/sanitize-text.decorator";

export class CreateSaleItemDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsString()
  productName: string;

  @IsOptional()
  @IsString()
  barcode?: string;

  /**
   * Precio unitario enviado por el cliente.
   * Regla de impuestos:
   * - Si el negocio tiene 'taxIncluded = true', este precio YA DEBE traer el impuesto sumado.
   * - Si el negocio tiene 'taxIncluded = false', este precio NO DEBE traer el impuesto.
   */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice: number;

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
}

export class PaymentDto {
  @IsEnum(PosPaymentMethod)
  method: PosPaymentMethod;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountTendered?: number;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  exchangeRate?: number;
}

export class CreditPlanDto {
  @IsOptional()
  @IsEnum(['SINGLE', 'INSTALLMENTS'])
  mode?: 'SINGLE' | 'INSTALLMENTS';

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  installmentsCount?: number;

  @IsOptional()
  @IsEnum(['SEMANAL', 'QUINCENAL', 'MENSUAL'])
  frequency?: 'SEMANAL' | 'QUINCENAL' | 'MENSUAL';

  @IsOptional()
  @IsString()
  firstDueDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  interestRate?: number;

  @IsOptional()
  @IsString()
  approvalToken?: string;
}

export class CreateSaleDto {
  @IsOptional()
  @IsString()
  cashRegisterId?: string;

  @IsOptional()
  @IsBoolean()
  isSplitSale?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items: CreateSaleItemDto[];

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  creditDueDate?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreditPlanDto)
  creditPlan?: CreditPlanDto;

  @IsOptional()
  @SanitizeText()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  customerPhone?: string;

  @IsOptional()
  @IsString()
  customerRuc?: string;

  // Legacy fallback fields for backward compatibility
  @IsOptional()
  @IsEnum(PosPaymentMethod)
  paymentMethod?: PosPaymentMethod;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountPaid?: number;

  @IsOptional()
  @IsString()
  reference?: string;

  // New multi-payment structure
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentDto)
  payments?: PaymentDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @SanitizeText()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  tableNumber?: string;

  @IsOptional()
  @IsString()
  zoneName?: string;

  @IsOptional()
  @IsString()
  waiterName?: string;

  @IsOptional()
  @IsString()
  vehicleInfo?: string;

  @IsOptional()
  @IsString()
  workshopVehicleId?: string;

  // Snapshot del cliente (offline o offline/online sync tolerante)
  @IsOptional()
  @IsNumber()
  clientTaxRate?: number;

  @IsOptional()
  clientTaxEnabled?: boolean;

  @IsOptional()
  clientTaxIncluded?: boolean;

  @IsOptional()
  @IsNumber()
  clientTaxAmount?: number;

  @IsOptional()
  @IsNumber()
  clientTotal?: number;

  @IsOptional()
  @IsNumber()
  clientListPriceTotal?: number;

  @IsOptional()
  @IsNumber()
  clientListDiscountTotal?: number;

  @IsOptional()
  isOfflineSync?: boolean;

  @IsOptional()
  @IsString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  approvalToken?: string;

  @IsOptional()
  @IsString()
  sellerId?: string;

  @IsOptional()
  @IsString()
  sellerName?: string;

  @IsOptional()
  @IsString()
  presaleTicketId?: string;
}
