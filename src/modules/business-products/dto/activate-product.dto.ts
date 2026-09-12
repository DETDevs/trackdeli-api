import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { PosVertical } from '@prisma/client';

export class ActivateProductDto {
  // Configuración opcional DELIVERY
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  commissionRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  altCommissionRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  altCommissionDistanceKm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  dispatchTimeoutMin?: number;

  // Configuración opcional POS
  @IsOptional()
  @IsEnum(PosVertical)
  posVertical?: PosVertical;

  @IsOptional()
  @IsNumber()
  @Min(0)
  posMonthlyFee?: number;

  // Motivo opcional de activación / actualización
  @IsOptional()
  @IsString()
  reason?: string;
}
