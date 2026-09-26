import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class CreateWaiterDto {
  @IsNotEmpty({ message: 'El nombre del mesero es obligatorio' })
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  name: string;

  @IsNotEmpty({ message: 'El PIN es obligatorio' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'El PIN debe ser exactamente de 4 dígitos numéricos' })
  pin: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
