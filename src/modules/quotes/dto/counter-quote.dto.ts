import { Type } from 'class-transformer';
import { IsNumber, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CounterQuoteDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  counterFee: number;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  message: string;
}