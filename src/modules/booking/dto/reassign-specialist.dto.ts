import { IsNotEmpty, IsString } from 'class-validator';

export class ReassignSpecialistDto {
  @IsNotEmpty({ message: 'El specialistId es obligatorio' })
  @IsString({ message: 'El specialistId debe ser una cadena de texto' })
  specialistId: string;
}
