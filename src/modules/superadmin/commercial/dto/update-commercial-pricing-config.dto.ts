import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpdateCommercialPricingConfigDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  soloSistemaPriceUsd?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  comboCompletoPriceUsd?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maintenanceMonthlyNio?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  maintenanceFreeMonths?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultCreditDownPaymentPct?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  maxCreditInstallments?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  defaultGraceDays?: number;
}
