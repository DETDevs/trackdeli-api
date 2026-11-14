import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpdateQuoteStatusDto {
  @IsString()
  @IsIn(['SENT', 'ACCEPTED', 'CANCELLED'], {
    message: 'Estado destino inválido (use SENT, ACCEPTED o CANCELLED)',
  })
  status: 'SENT' | 'ACCEPTED' | 'CANCELLED';

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;
}

