import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateAppointmentDto {
  @IsNotEmpty({ message: 'El serviceId es obligatorio' })
  @IsString()
  serviceId: string;

  @IsNotEmpty({ message: 'La fecha y hora de la cita (scheduledAt) es obligatoria' })
  @IsString()
  scheduledAt: string;

  @IsNotEmpty({ message: 'El nombre del cliente es obligatorio' })
  @IsString()
  customerName: string;

  @IsNotEmpty({ message: 'El teléfono del cliente es obligatorio' })
  @IsString()
  customerPhone: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo electrónico ingresado no es válido' })
  customerEmail?: string;
}
