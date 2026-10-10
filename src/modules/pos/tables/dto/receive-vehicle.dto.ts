import { IsInt, IsNotEmpty, IsOptional, IsString, Length, MaxLength, Min } from 'class-validator';

export class ReceiveVehicleDto {
  @IsString()
  @IsNotEmpty({ message: 'El identificador o placa del vehículo es obligatorio' })
  @MaxLength(50, { message: 'La placa no puede exceder 50 caracteres' })
  number: string;

  @IsString()
  @IsNotEmpty({ message: 'ZONE_REQUIRED' })
  zoneId: string;

  @IsString({ message: 'El nombre del cliente debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre del cliente es obligatorio en el perfil Taller' })
  @Length(2, 120, { message: 'El nombre del cliente debe tener entre 2 y 120 caracteres' })
  customerName: string;

  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'El teléfono del cliente no puede exceder 30 caracteres' })
  customerPhone?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'La información del vehículo no puede exceder 120 caracteres' })
  vehicleInfo?: string;

  @IsOptional()
  @IsInt({ message: 'El kilometraje debe ser un número entero' })
  @Min(0, { message: 'El kilometraje no puede ser negativo' })
  mileage?: number;

  @IsOptional()
  technicianId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

