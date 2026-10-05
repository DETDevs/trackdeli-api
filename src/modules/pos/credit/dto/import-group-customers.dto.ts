import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ImportCustomerRowDto {
  @IsOptional()
  @IsString({ message: 'El código de carnet (externalCode) debe ser un texto' })
  externalCode?: string;

  @IsOptional()
  @IsString({ message: 'El nombre del empleado debe ser un texto' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'La identificación (identification) debe ser un texto' })
  identification?: string;

  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto' })
  phone?: string;

  @IsOptional()
  @IsNumber({}, { message: 'El límite de crédito debe ser un número' })
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
