import { IsNotEmpty, IsString } from 'class-validator';

export class CancelPresaleTicketDto {
  @IsString()
  @IsNotEmpty({ message: 'El motivo de anulación es obligatorio' })
  reason: string;
}
