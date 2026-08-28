import { IsNumber, Min, IsOptional, IsString } from 'class-validator';

export class CloseCashRegisterDto {
  @IsNumber()
  @Min(0)
  closingCash: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
