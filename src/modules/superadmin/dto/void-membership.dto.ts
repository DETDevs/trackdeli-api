import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class VoidMembershipDto {
  @IsString({ message: 'El motivo debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El motivo de anulación es obligatorio' })
  @MinLength(5, { message: 'El motivo de anulación debe tener al menos 5 caracteres' })
  @SanitizeText()
  reason: string;
}

