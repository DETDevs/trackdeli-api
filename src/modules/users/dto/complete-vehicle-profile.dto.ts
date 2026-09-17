import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { VehicleType } from '@prisma/client';

export class CompleteVehicleProfileDto {
  @IsEnum(VehicleType)
  @IsNotEmpty()
  vehicleType: VehicleType;

  @IsString()
  @IsNotEmpty()
  vehiclePlate: string;

  @IsString()
  @IsNotEmpty()
  vehicleColor: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  phone?: string;
}
