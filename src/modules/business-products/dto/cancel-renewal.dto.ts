import { IsOptional, IsString } from 'class-validator';

export class CancelRenewalDto {
  @IsString()
  @IsOptional()
  reason?: string;
}
