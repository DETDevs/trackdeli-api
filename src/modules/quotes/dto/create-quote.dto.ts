import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateQuoteDto {
  @IsString()
  orderId: string;

  @IsNumber()
  @Min(0)
  proposedFee: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  distanceToBusinessKm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  etaToBusinessMin?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}