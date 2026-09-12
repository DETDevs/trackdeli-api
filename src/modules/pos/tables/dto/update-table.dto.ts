import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TableShape } from '@prisma/client';

export class UpdateTableDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  number?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacity?: number;

  @IsOptional()
  @IsEnum(TableShape)
  shape?: TableShape;

  @IsOptional()
  @IsInt()
  @Min(0)
  gridX?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  gridY?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
