import { IsOptional, IsString } from 'class-validator';

export class DeactivateProductDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
