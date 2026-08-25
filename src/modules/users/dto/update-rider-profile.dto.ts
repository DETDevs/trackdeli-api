import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { VehicleType } from '@prisma/client';

export class UpdateRiderProfileDto {
  @IsOptional()
  @IsString()
  name?: string;
  
  @IsOptional()
  @IsString()
  phone?: string;
  
  @IsOptional()
  @IsEnum(VehicleType)
  vehicleType?: VehicleType;
  
  @IsOptional()
  @IsString()
  vehiclePlate?: string;
  
  @IsOptional()
  @IsString()
  vehicleColor?: string;
  
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}
