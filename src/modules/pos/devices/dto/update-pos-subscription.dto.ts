import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';

export class UpdatePosSubscriptionDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxDevices?: number | null;

  @IsOptional()
  @IsBoolean()
  webAdminEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  webBillingEnabled?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  maxWebDevices?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  webBillingMonthlyUsd?: number | null;

  @IsOptional()
  @IsIn(['RESTAURANTE', 'TALLER', null])
  salonProfile?: 'RESTAURANTE' | 'TALLER' | null;

  @IsOptional()
  @IsIn(['BASIC', 'PRO', null])
  backofficeTier?: 'BASIC' | 'PRO' | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  trialHours?: number | null;

  @IsOptional()
  @IsIn(['extend', 'reset', 'terminate', null])
  trialAction?: 'extend' | 'reset' | 'terminate' | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  extendHours?: number;
}
