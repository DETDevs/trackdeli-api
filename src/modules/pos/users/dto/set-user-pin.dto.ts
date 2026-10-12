import { IsNotEmpty, Matches } from 'class-validator';

export class SetUserPinDto {
  @IsNotEmpty({ message: 'El PIN es obligatorio' })
  @Matches(/^\d{4,6}$/, { message: 'El PIN debe tener entre 4 y 6 dígitos numéricos' })
  pin: string;
}
