import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class SetOrderDiscountDto {
  @IsOptional()
  @IsNumber({}, { message: 'discountPercent debe ser un número' })
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsNumber({}, { message: 'discountAmount debe ser un número' })
  @Min(0)
  discountAmount?: number;
}
