import { IsNumber, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CounterQuoteDto {
  @IsNumber()
  @Min(0)
  counterFee: number;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  message: string;
}