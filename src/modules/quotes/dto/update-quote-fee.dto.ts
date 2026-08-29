import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateQuoteFeeDto {
  @IsNumber()
  @Min(0)
  newFee: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  message?: string;
}