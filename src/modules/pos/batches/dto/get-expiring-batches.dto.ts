import { IsIn, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class GetExpiringBatchesDto {
  @IsOptional()
  @Type(() => Number)
  @IsIn([30, 60, 90])
  days?: number = 30;
}
