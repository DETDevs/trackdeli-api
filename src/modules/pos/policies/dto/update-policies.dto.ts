import { IsBoolean, IsNumber, IsString, IsOptional, Min, Max } from 'class-validator';

export class UpdatePosPoliciesDto {
  @IsOptional() @IsBoolean() returnsEnabled?: boolean;
  @IsOptional() @IsBoolean() returnsRequireApproval?: boolean;
  @IsOptional() @IsNumber() @Min(1) @Max(365) returnsMaxDays?: number;

  @IsOptional() @IsBoolean() voidsCompletedEnabled?: boolean;
  @IsOptional() @IsBoolean() voidsRequireApproval?: boolean;

  @IsOptional() @IsBoolean() discountsEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) cashierMaxDiscountPercent?: number;
  @IsOptional() @IsBoolean() priceOverrideEnabled?: boolean;

  @IsOptional() @IsString() paymentMethodsEnabled?: string;
  @IsOptional() @IsBoolean() requireReferenceCard?: boolean;
  @IsOptional() @IsBoolean() requireReferenceTransfer?: boolean;
  @IsOptional() @IsBoolean() requireReferenceOther?: boolean;

  @IsOptional() @IsBoolean() multiCurrencyEnabled?: boolean;
  @IsOptional() @IsString() acceptedCurrencies?: string;

  @IsOptional() @IsBoolean() blindCashClose?: boolean;
  @IsOptional() @IsNumber() @Min(0) cashDifferenceTolerance?: number;
  @IsOptional() @IsBoolean() noSaleDrawerOpenAllowed?: boolean;

  @IsOptional() @IsBoolean() allowNegativeStock?: boolean;
  @IsOptional() @IsBoolean() inventoryAdjustRequireApproval?: boolean;
  @IsOptional() @IsBoolean() creditLimitOverrideRequiresApproval?: boolean;
}
