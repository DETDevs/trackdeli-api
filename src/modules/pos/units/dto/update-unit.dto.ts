import { IsString, IsBoolean, IsOptional, IsNumber, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'El nombre de la unidad no puede superar los 100 caracteres.' })
  name?: string;

  @IsOptional()
  @IsBoolean()
  allowsDecimals?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
