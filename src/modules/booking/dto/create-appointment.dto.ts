import { IsArray, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateAppointmentDto {
  @IsOptional()
  @IsString({ message: 'El serviceId debe ser una cadena' })
  serviceId?: string;

  @IsOptional()
  @IsArray({ message: 'serviceIds debe ser un arreglo de cadenas' })
  @IsString({ each: true, message: 'Cada elemento de serviceIds debe ser una cadena' })
  serviceIds?: string[];

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

  @IsNotEmpty({ message: 'El holdId es obligatorio' })
  @IsString()
  holdId: string;

  @IsNotEmpty({ message: 'El holderToken es obligatorio' })
  @IsString()
  holderToken: string;
}
