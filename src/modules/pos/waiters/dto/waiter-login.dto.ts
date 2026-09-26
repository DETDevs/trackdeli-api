import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class WaiterLoginDto {
  @IsOptional()
  @IsString()
  waiterId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsNotEmpty({ message: 'El PIN es obligatorio' })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'El PIN debe ser exactamente de 4 dígitos numéricos' })
  pin: string;
}
