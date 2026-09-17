import { IsNotEmpty, IsString } from 'class-validator';

export class RescheduleAppointmentDto {
  @IsNotEmpty({ message: 'La nueva fecha y hora (newScheduledAt) es obligatoria' })
  @IsString()
  newScheduledAt: string;
}
