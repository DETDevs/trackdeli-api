import { IsNotEmpty, IsString } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class DeleteBusinessDto {
  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  confirmName: string;
}
