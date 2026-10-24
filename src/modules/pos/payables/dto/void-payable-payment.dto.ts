import { IsString, IsNotEmpty } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class VoidPayablePaymentDto {
  @IsNotEmpty({ message: 'El motivo de anulación es obligatorio' })
  @SanitizeText()
  @IsString()
  reason: string;
}
