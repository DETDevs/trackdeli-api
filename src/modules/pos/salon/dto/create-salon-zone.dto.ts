import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateSalonZoneDto {
  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(40)
  name: string;
}
