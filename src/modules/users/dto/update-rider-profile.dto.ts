import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { VehicleType } from '@prisma/client';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class UpdateRiderProfileDto {
  @IsOptional()
  @SanitizeText()
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
