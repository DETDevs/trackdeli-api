import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class RegisterWebDeviceDto {
  @IsNotEmpty({ message: 'El deviceId es requerido' })
  @IsUUID('all', { message: 'El deviceId debe ser un UUID válido' })
  deviceId: string;

  @IsNotEmpty({ message: 'El nombre del dispositivo es requerido' })
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
