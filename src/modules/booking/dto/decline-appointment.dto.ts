import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class DeclineAppointmentDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
