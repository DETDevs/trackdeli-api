import { IsNumber, Min, IsOptional, IsString } from 'class-validator';

export class OpenCashRegisterDto {
  @IsNumber()
  @Min(0)
  openingCash: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
