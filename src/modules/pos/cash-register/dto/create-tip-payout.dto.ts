import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateTipPayoutDto {
  @IsString({ message: 'El mesero es obligatorio.' })
  @IsNotEmpty({ message: 'El mesero es obligatorio.' })
  waiterId: string;

  @IsString({ message: 'El identificador de solicitud es obligatorio.' })
  @IsNotEmpty({ message: 'El identificador de solicitud es obligatorio.' })
  @MaxLength(100, { message: 'El identificador de solicitud no puede superar 100 caracteres.' })
  clientRequestId: string;
}
