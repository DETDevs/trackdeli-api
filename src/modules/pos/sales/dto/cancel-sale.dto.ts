import { IsString, IsOptional } from 'class-validator';

export class CancelSaleDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
