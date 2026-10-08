import { IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export class UpdatePosSubscriptionDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxDevices?: number | null;

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
