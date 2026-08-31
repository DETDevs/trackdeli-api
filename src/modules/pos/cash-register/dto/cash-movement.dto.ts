import { IsNumber, IsString, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CashMovementDto {
  @IsOptional()
  @IsString()
  type?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  concept?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
