import { IsString, Length, Matches } from 'class-validator';

export class JoinBusinessDto {
  @IsString()
  @Length(6, 6, { message: 'El código debe tener exactamente 6 dígitos' })
  @Matches(/^\d{6}$/, { message: 'El código debe ser numérico' })
  code: string;
}
