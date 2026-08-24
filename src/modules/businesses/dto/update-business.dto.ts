import { IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, IsNumber } from 'class-validator';

export class UpdateBusinessDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  type?: string;

  @IsUrl()
  @IsOptional()
  logoUrl?: string;

  @IsInt()
  @IsOptional()
  @Min(30)
  @Max(500)
  defaultGeofenceRadiusM?: number;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;
}
