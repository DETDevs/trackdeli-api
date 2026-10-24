import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsString } from 'class-validator';
import { VALID_DOCUMENT_TYPES, PrintDocumentType } from './create-print-event.dto';

export class GetPrintCountsDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_DOCUMENT_TYPES, {
    message: `documentType debe ser uno de: ${VALID_DOCUMENT_TYPES.join(', ')}`,
  })
  documentType: PrintDocumentType;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200, { message: 'El lote de IDs no puede exceder 200 elementos' })
  ids: string[];
}
