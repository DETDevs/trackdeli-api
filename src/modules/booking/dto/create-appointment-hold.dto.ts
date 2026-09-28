import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateAppointmentHoldDto {
  @IsNotEmpty({ message: 'El serviceId es obligatorio' })
  @IsString()
  serviceId: string;

  @IsOptional()
  @IsString()
  specialistId?: string;

  @IsNotEmpty({ message: 'La fecha y hora de inicio (startAt) es obligatoria' })
  @IsString()
  startAt: string;
}
