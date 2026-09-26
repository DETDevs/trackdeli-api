import { IsBoolean, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class UpdateWaiterDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}$/, { message: 'El PIN debe ser exactamente de 4 dígitos numéricos' })
  pin?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
