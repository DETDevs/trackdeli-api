import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const VALID_DOCUMENT_TYPES = [
  'SALE',
  'TABLE_ORDER',
  'PURCHASE',
  'CASH_CLOSE',
  'CREDIT_PAYMENT',
  'EXPENSE',
  'SUPPLIER_PAYMENT',
  'SALE_RETURN',
] as const;

export type PrintDocumentType = typeof VALID_DOCUMENT_TYPES[number];

export const VALID_EVENT_TYPES = ['PRINT', 'SHARE'] as const;
export type PrintEventType = typeof VALID_EVENT_TYPES[number];

export const VALID_STATUS_TYPES = ['OK', 'FAILED'] as const;
export type PrintStatusType = typeof VALID_STATUS_TYPES[number];

export const VALID_COPY_TYPES = ['CUSTOMER', 'BUSINESS'] as const;
export type PrintCopyType = typeof VALID_COPY_TYPES[number];

export class CreatePrintEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  clientEventId: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_DOCUMENT_TYPES, {
    message: `documentType debe ser uno de: ${VALID_DOCUMENT_TYPES.join(', ')}`,
  })
  documentType: PrintDocumentType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  documentId: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_EVENT_TYPES, {
    message: `eventType debe ser uno de: ${VALID_EVENT_TYPES.join(', ')}`,
  })
  eventType: PrintEventType;

  @IsOptional()
  @IsArray()
  @IsIn(VALID_COPY_TYPES, {
    each: true,
    message: `cada copia debe ser una de: ${VALID_COPY_TYPES.join(', ')}`,
  })
  copies?: string[];

  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_STATUS_TYPES, {
    message: `status debe ser uno de: ${VALID_STATUS_TYPES.join(', ')}`,
  })
  status: PrintStatusType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  stationName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  cashRegisterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @IsNotEmpty()
  occurredAt: string | Date;

  // Si el cliente envía userId, lo permitimos en el DTO pero el servidor siempre lo sobreescribe con el del JWT
  @IsOptional()
  @IsString()
  userId?: string;
}

export class BatchPrintEventsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePrintEventDto)
  events: CreatePrintEventDto[];
}
