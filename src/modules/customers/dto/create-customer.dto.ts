import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateCustomerDto {
  @IsOptional()
  @IsString({ message: 'businessId debe ser una cadena de texto' })
  businessId?: string;

  @SanitizeText()
  @IsNotEmpty({ message: 'El nombre del cliente es obligatorio' })
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @MaxLength(100, { message: 'El nombre no puede superar 100 caracteres' })
  name: string;

  @IsOptional()
  @IsString({ message: 'El teléfono debe ser una cadena de texto' })
  @MaxLength(30, { message: 'El teléfono no puede superar 30 caracteres' })
  @ValidateIf((_o, v) => typeof v === 'string' && v.trim() !== '')
  @Matches(/^[0-9+ ()-]{7,25}$/, { message: 'El formato del teléfono no es válido' })
  phone?: string;

  @IsOptional()
  @IsString({ message: 'El RUC debe ser una cadena de texto' })
  @MaxLength(30, { message: 'La cédula/RUC no puede superar 30 caracteres' })
  ruc?: string;

  /** Cédula/RUC (alias de `ruc`). */
  @IsOptional()
  @IsString({ message: 'La cédula/RUC debe ser una cadena de texto' })
  @MaxLength(30, { message: 'La cédula/RUC no puede superar 30 caracteres' })
  documentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El límite de crédito debe ser un número' })
  @Min(0, { message: 'El límite de crédito no puede ser negativo' })
  creditLimit?: number | null;

  @IsOptional()
  @IsBoolean({ message: 'isBlocked debe ser un booleano' })
  isBlocked?: boolean;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'La dirección debe ser una cadena de texto' })
  @MaxLength(300, { message: 'La dirección no puede superar 300 caracteres' })
  address?: string;

  @IsOptional()
  @IsString({ message: 'El correo debe ser una cadena de texto' })
  @MaxLength(255, { message: 'El correo no puede superar 255 caracteres' })
  @ValidateIf((_o, v) => typeof v === 'string' && v.trim() !== '')
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email?: string;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'Las notas deben ser una cadena de texto' })
  @MaxLength(2000, { message: 'Las notas no pueden superar 2000 caracteres' })
  notes?: string;

  @IsOptional()
  @IsString({ message: 'El ID de la empresa debe ser una cadena de texto' })
  groupId?: string;

  @IsOptional()
  @IsString({ message: 'El código de empleado/carnet debe ser una cadena de texto' })
  @MaxLength(50, { message: 'El código de empleado/carnet no puede superar 50 caracteres' })
  externalCode?: string;

  /**
   * 207a: si es true, antes de guardar se buscan duplicados (cédula/RUC o teléfono)
   * y se responde 409 DUPLICATE_CUSTOMER con el cliente existente.
   * Si se omite, el comportamiento es el de siempre (cobro 191).
   */
  @IsOptional()
  @IsBoolean({ message: 'checkDuplicates debe ser verdadero o falso' })
  checkDuplicates?: boolean;

  /** 207a: confirma crear aunque exista un duplicado de cédula/RUC. */
  @IsOptional()
  @IsBoolean({ message: 'confirmDuplicates debe ser verdadero o falso' })
  confirmDuplicates?: boolean;
}
