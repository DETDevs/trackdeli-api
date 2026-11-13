import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class SetOrderTipDto {
  @IsOptional()
  @IsString()
  subAccountId?: string;

  @IsString()
  @IsIn(['NONE', 'PERCENT', 'CUSTOM'])
  mode: 'NONE' | 'PERCENT' | 'CUSTOM';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  percent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  @IsIn(['NIO', 'USD'])
  currency?: 'NIO' | 'USD';
}

