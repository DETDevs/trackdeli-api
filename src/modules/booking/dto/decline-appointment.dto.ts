import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeclineAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
