import { IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export class UpdatePosSubscriptionDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxDevices?: number | null;

  @IsOptional()
  @IsIn(['RESTAURANTE', 'TALLER', null])
  salonProfile?: 'RESTAURANTE' | 'TALLER' | null;
}
