import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateAppointmentHoldDto {
  @IsOptional()
  @IsString({ message: 'serviceId debe ser una cadena' })
  serviceId?: string;

  @IsOptional()
  @IsArray({ message: 'serviceIds debe ser un arreglo de cadenas' })
  @IsString({ each: true, message: 'Cada elemento de serviceIds debe ser una cadena' })
  serviceIds?: string[];

  @IsOptional()
  @IsString()
  specialistId?: string;

  @IsNotEmpty({ message: 'La fecha y hora de inicio (startAt) es obligatoria' })
  @IsString()
  startAt: string;
}
