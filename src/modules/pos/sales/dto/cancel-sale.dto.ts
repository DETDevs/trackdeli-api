import { IsString, IsOptional } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CancelSaleDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  reason?: string;
}
