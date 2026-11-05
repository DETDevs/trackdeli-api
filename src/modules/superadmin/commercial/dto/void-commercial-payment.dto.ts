import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class VoidCommercialPaymentDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10, { message: 'El motivo de anulación debe tener al menos 10 caracteres' })
  @SanitizeText()
  reason: string;
}

