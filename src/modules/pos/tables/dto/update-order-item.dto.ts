import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateOrderItemDto {
  @IsNumber()
  @Min(0)
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}
