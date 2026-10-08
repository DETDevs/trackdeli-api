import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class UpdateOrderAssignmentDto {
  @IsOptional()
  technicianId?: string | null;

  @IsOptional()
  @IsString({ message: 'El nombre del cliente debe ser un texto' })
  @Length(2, 120, { message: 'El nombre del cliente debe tener entre 2 y 120 caracteres' })
  customerName?: string;

  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto' })
  @MaxLength(30, { message: 'El teléfono no puede exceder 30 caracteres' })
  customerPhone?: string;

  @IsOptional()
  @IsString({ message: 'La información del vehículo debe ser un texto' })
  @MaxLength(120, { message: 'La información del vehículo no puede exceder 120 caracteres' })
  vehicleInfo?: string;
}
