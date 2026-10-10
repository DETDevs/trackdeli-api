import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateWorkshopVehicleDto {
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'La placa no puede exceder 50 caracteres' })
  plate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'La descripción no puede exceder 200 caracteres' })
  description?: string;

  @IsOptional()
  @IsString()
  customerId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'El nombre del cliente no puede exceder 120 caracteres' })
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'El teléfono no puede exceder 30 caracteres' })
  customerPhone?: string;

  @IsOptional()
  @IsInt({ message: 'El kilometraje debe ser un número entero' })
  @Min(0, { message: 'El kilometraje no puede ser negativo' })
  lastMileage?: number | null;
}
