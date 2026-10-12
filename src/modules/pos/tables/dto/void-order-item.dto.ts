import { IsOptional, IsString, IsNumber, Min } from 'class-validator';

export class VoidOrderItemDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  authorizerPin?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.001)
  qty?: number;
}
