import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateOrderItemDto {
  @IsInt()
  @Min(0)
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}
