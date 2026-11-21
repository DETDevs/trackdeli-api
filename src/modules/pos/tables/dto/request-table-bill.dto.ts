import { IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class RequestBillTipDto {
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

export class RequestTableBillDto {
  @IsOptional()
  @IsString()
  subAccountId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RequestBillTipDto)
  tip?: RequestBillTipDto;

  @IsOptional()
  @IsString()
  clientRequestId?: string;
}
