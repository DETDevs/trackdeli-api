import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpdatePreventaSettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Los días sugeridos de entrega deben ser un número entero.' })
  @Min(0, { message: 'Los días sugeridos de entrega no pueden ser negativos.' })
  @Max(60, { message: 'Los días sugeridos de entrega no pueden superar 60.' })
  defaultDeliveryDaysOffset?: number;

  @IsOptional()
  @IsBoolean()
  allowSellerPriceEdit?: boolean;

  @IsOptional()
  @IsBoolean()
  allowSellerDiscounts?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['WARN', 'BLOCK'], { message: 'La política por mora debe ser WARN o BLOCK.' })
  creditPolicyOnOverdue?: 'WARN' | 'BLOCK';

  @IsOptional()
  @IsString()
  @IsIn(['WARN', 'BLOCK'], { message: 'La política por límite de crédito debe ser WARN o BLOCK.' })
  creditPolicyOnLimitExceeded?: 'WARN' | 'BLOCK';

  @IsOptional()
  @IsBoolean()
  allowSellerCreditPayments?: boolean;

  @IsOptional()
  @IsBoolean()
  allowSellerCreateCustomers?: boolean;

  @IsOptional()
  @IsBoolean()
  requireGpsOnVisit?: boolean;

  @IsOptional()
  @IsBoolean()
  allowCreditDeliveryWithoutShift?: boolean;

  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'El prefijo del pedido debe ser texto.' })
  @IsNotEmpty({ message: 'El prefijo del pedido no puede estar vacío.' })
  @MaxLength(10, { message: 'El prefijo del pedido no puede superar 10 caracteres.' })
  preorderNumberPrefix?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt({ message: 'Los días de vencimiento de reserva deben ser un número entero.' })
  @Min(1, { message: 'Los días de vencimiento de reserva deben ser al menos 1.' })
  @Max(365, { message: 'Los días de vencimiento de reserva no pueden superar 365.' })
  reservationExpireDays?: number | null;
}
