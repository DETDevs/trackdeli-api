import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateAppointmentDto {
  @IsNotEmpty({ message: 'El serviceId es obligatorio' })
  @IsString()
  serviceId: string;

  @IsOptional()
  @IsString()
  specialistId?: string;

  @IsNotEmpty({ message: 'La fecha y hora de la cita (scheduledAt) es obligatoria' })
  @IsString()
  scheduledAt: string;

  @SanitizeText()
  @IsNotEmpty({ message: 'El nombre del cliente es obligatorio' })
  @IsString()
  customerName: string;

  @IsNotEmpty({ message: 'El teléfono del cliente es obligatorio' })
  @IsString()
  customerPhone: string;

  @IsNotEmpty({ message: 'El correo electrónico es obligatorio para enviar la confirmación de la cita' })
  @IsEmail({}, { message: 'El correo electrónico ingresado no es válido' })
  customerEmail: string;
}
