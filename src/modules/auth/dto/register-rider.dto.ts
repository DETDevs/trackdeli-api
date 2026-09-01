import { IsEmail, IsEnum, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
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
  @Length(6, 6, { message: 'El código debe tener exactamente 6 dígitos' })
  @Matches(/^\d{6}$/, { message: 'El código debe ser numérico' })
  inviteCode?: string;
}
