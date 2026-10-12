import { IsEnum, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export enum SplitMode {
  ITEMS = 'ITEMS',
  EQUAL = 'EQUAL',
}

export class StartSplitDto {
  @IsEnum(SplitMode, { message: 'El modo de división debe ser ITEMS o EQUAL' })
  mode: SplitMode;

  @IsOptional()
  @IsInt({ message: 'Las partes deben ser un número entero' })
  @Min(2, { message: 'Mínimo 2 partes' })
  @Max(12, { message: 'Máximo 12 partes' })
  parts?: number;

  @IsOptional()
  @IsNumber({}, { message: 'discountPercent debe ser un número' })
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsOptional()
  @IsNumber({}, { message: 'discountAmount debe ser un número' })
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  splitVersion?: number;
}
