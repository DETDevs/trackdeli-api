import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class VoidSaleDto {
  @IsNotEmpty({ message: 'El motivo de anulación es obligatorio' })
  @SanitizeText()
  @IsString()
  reason: string;

  @IsOptional()
  @IsString()
  approvalToken?: string;
}
