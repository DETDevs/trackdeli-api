import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateExchangeRateDto {
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1000)
  rate: number;

  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
