import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReceiveVehicleDto {
  @IsString()
  @IsNotEmpty({ message: 'El identificador o placa del vehículo es obligatorio' })
  @MaxLength(50, { message: 'La placa no puede exceder 50 caracteres' })
  number: string;

  @IsString()
  @IsNotEmpty({ message: 'ZONE_REQUIRED' })
  zoneId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
