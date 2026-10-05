import { IsBoolean, IsEmail, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class CreateCreditGroupDto {
  @SanitizeText()
  @IsNotEmpty({ message: 'El nombre de la empresa/convenio es obligatorio' })
  @IsString({ message: 'El nombre debe ser una cadena de texto' })
  @MaxLength(150, { message: 'El nombre no puede exceder 150 caracteres' })
  name: string;

  @IsOptional()
  @IsString({ message: 'El RUC/identificación debe ser una cadena de texto' })
  @MaxLength(50, { message: 'El RUC no puede exceder 50 caracteres' })
  taxId?: string;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El nombre del contacto debe ser una cadena de texto' })
  @MaxLength(150, { message: 'El nombre del contacto no puede exceder 150 caracteres' })
  contactName?: string;

  @IsOptional()
  @IsString({ message: 'El teléfono de contacto debe ser una cadena de texto' })
  @MaxLength(50, { message: 'El teléfono de contacto no puede exceder 50 caracteres' })
  contactPhone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  @MaxLength(255, { message: 'El correo electrónico no puede exceder 255 caracteres' })
  contactEmail?: string;

  @IsOptional()
  @IsIn(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'MANUAL'], {
    message: 'El ciclo de corte debe ser WEEKLY, BIWEEKLY, MONTHLY o MANUAL',
  })
  billingCycle?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'MANUAL';

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El día de corte 1 debe ser un número entero' })
  @Min(1, { message: 'El día de corte 1 debe estar entre 1 y 31' })
  @Max(31, { message: 'El día de corte 1 debe estar entre 1 y 31' })
  cutDay1?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El día de corte 2 debe ser un número entero' })
  @Min(1, { message: 'El día de corte 2 debe estar entre 1 y 31' })
  @Max(31, { message: 'El día de corte 2 debe estar entre 1 y 31' })
  cutDay2?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'payDayOffset debe ser un número entero' })
  @Min(0, { message: 'payDayOffset no puede ser negativo' })
  @Max(90, { message: 'payDayOffset no puede exceder 90 días' })
  payDayOffset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El límite de crédito debe ser un número' })
  @Min(0, { message: 'El límite de crédito no puede ser negativo' })
  creditLimit?: number;

  @IsOptional()
  @IsBoolean({ message: 'isActive debe ser un booleano' })
  isActive?: boolean;
}
