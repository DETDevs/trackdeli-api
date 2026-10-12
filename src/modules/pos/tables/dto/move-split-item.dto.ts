import { IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class MoveSplitItemDto {
  @IsNotEmpty({ message: 'itemId es requerido' })
  @IsString()
  itemId: string;

  @IsNotEmpty({ message: 'toSubAccountId es requerido' })
  @IsString()
  toSubAccountId: string;

  @IsOptional()
  @IsNumber({}, { message: 'qty debe ser un número positivo' })
  @Min(0.001, { message: 'qty debe ser mayor a 0' })
  qty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  splitVersion?: number;
}
