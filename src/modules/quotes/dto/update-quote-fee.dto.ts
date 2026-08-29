import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateQuoteFeeDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  newFee?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  proposedFee?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fee?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  counterFee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}