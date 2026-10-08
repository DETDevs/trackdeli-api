import { IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export class UpdatePosSubscriptionDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxDevices?: number | null;
}
