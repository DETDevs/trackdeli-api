import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { VehicleType } from '@prisma/client';

export class RegisterRiderDto {
  @IsEmail()
  email: string;
  
  @IsString()
  @MinLength(6)
  password: string;
  
  @IsString()
  @MinLength(2)
  name: string;
  
  @IsString()
  phone: string;
  
  @IsEnum(VehicleType)
  vehicleType: VehicleType;
  
  @IsOptional()
  @IsString()
  vehiclePlate?: string;
  
  @IsOptional()
  @IsString()
  vehicleColor?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  inviteCode?: string;
}
