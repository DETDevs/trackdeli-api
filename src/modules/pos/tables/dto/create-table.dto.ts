import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TableShape } from '@prisma/client';

export class CreateTableDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  number: string;

  @IsInt()
  @Min(1)
  @Max(100)
  capacity: number;

  @IsOptional()
  @IsEnum(TableShape)
  shape?: TableShape;

  @IsInt()
  @Min(0)
  gridX: number;

  @IsInt()
  @Min(0)
  gridY: number;
}
