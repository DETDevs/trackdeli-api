import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateCreditStatementDto {
  @IsNotEmpty({ message: 'La fecha inicial (from) es obligatoria' })
  @IsString({ message: 'from debe ser una cadena de texto (fecha ISO o YYYY-MM-DD)' })
  from: string;

  @IsNotEmpty({ message: 'La fecha final (to) es obligatoria' })
  @IsString({ message: 'to debe ser una cadena de texto (fecha ISO o YYYY-MM-DD)' })
  to: string;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'notes debe ser una cadena de texto' })
  notes?: string;
}
