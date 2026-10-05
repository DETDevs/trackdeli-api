import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ImportCustomerRowDto {
  @IsString()
  @IsNotEmpty({ message: 'El código de carnet (externalCode) es requerido' })
  externalCode: string;

  @IsString()
  @IsNotEmpty({ message: 'El nombre del empleado es requerido' })
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsNumber({}, { message: 'El límite de crédito debe ser un número' })
  @Min(0, { message: 'El límite de crédito no puede ser negativo' })
  creditLimit?: number;
}

export class ImportGroupCustomersDto {
  @IsArray({ message: 'El cuerpo debe contener un arreglo de filas (rows)' })
  @ValidateNested({ each: true })
  @Type(() => ImportCustomerRowDto)
  rows: ImportCustomerRowDto[];

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
