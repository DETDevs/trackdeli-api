import { IsString, MaxLength, MinLength } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class SendQuoteMessageDto {
  @SanitizeText()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message: string;
}