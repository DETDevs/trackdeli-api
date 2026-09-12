import { IsNumber, Min, Max, IsOptional, IsString, MaxLength, Length, IsEnum, IsInt } from 'class-validator';
import { PosVertical } from '@prisma/client';

export class UpdatePosSettingsDto {
  @IsOptional()
  @IsEnum(PosVertical)
  posVertical?: PosVertical;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(50)
  gridColumns?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(50)
  gridRows?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;

  @IsOptional()
  @IsString()
  @Length(1, 10)
  invoicePrefix?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  posAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  posPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  posFooter?: string;
}

