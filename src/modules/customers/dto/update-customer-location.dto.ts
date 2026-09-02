import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateCustomerLocationDto {
  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  addressText?: string;

  @IsOptional()
  @IsBoolean()
  confirmedSameLocation?: boolean;
}
