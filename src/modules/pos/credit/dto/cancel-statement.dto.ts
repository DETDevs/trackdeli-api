import { IsNotEmpty, IsString } from 'class-validator';

export class CancelCreditStatementDto {
  @IsString({ message: 'El motivo debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El motivo de cancelación es obligatorio' })
  reason: string;
}
