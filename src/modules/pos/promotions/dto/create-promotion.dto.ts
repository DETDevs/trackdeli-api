import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';
import {
  PROMOTION_CHANNELS,
  PROMOTION_SCOPES,
  PROMOTION_TYPES,
  PromotionScope,
  PromotionType,
} from '../promotions-engine.util';

export class CreatePromotionDto {
  @SanitizeText()
  @IsString({ message: 'El nombre de la promoción debe ser texto.' })
  @IsNotEmpty({ message: 'El nombre de la promoción es obligatorio.' })
  @MaxLength(150, { message: 'El nombre no puede superar los 150 caracteres.' })
  name: string;

  @IsIn(PROMOTION_TYPES, {
    message: 'El tipo debe ser PERCENT_DISCOUNT, FIXED_DISCOUNT, BUY_N_PAY_M o QTY_PRICE_TIER.',
  })
  type: PromotionType;

  @IsIn(PROMOTION_SCOPES, {
    message: 'El alcance debe ser PRODUCT o CATEGORY.',
  })
  scope: PromotionScope;

  @IsOptional()
  @IsArray({ message: 'productIds debe ser un arreglo.' })
  @IsString({ each: true })
  productIds?: string[];

  @IsOptional()
  @IsArray({ message: 'categoryIds debe ser un arreglo.' })
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El porcentaje de descuento debe ser un número.' })
  discountPct?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El monto de descuento debe ser un número.' })
  discountAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'buyQty debe ser un número entero.' })
  buyQty?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'payQty debe ser un número entero.' })
  payQty?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'La cantidad mínima debe ser un número.' })
  minQty?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'El precio por cantidad debe ser un número.' })
  @Min(0, { message: 'El precio por cantidad no puede ser negativo.' })
  tierUnitPrice?: number | null;

  @IsOptional()
  @IsString()
  startsAt?: string | null;

  @IsOptional()
  @IsString()
  endsAt?: string | null;

  @IsOptional()
  @IsArray({ message: 'daysOfWeek debe ser un arreglo de días (0 a 6).' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'Cada día de la semana debe ser un entero entre 0 y 6.' })
  @Min(0, { each: true, message: 'Cada día debe ser entre 0 (domingo) y 6 (sábado).' })
  @Max(6, { each: true, message: 'Cada día debe ser entre 0 (domingo) y 6 (sábado).' })
  daysOfWeek?: number[];

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'La hora de inicio debe tener el formato HH:mm (por ejemplo, 14:00).',
  })
  startTime?: string | null;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'La hora de fin debe tener el formato HH:mm (por ejemplo, 17:00).',
  })
  endTime?: string | null;

  @IsOptional()
  @IsArray({ message: 'channels debe ser un arreglo.' })
  @IsIn(PROMOTION_CHANNELS, {
    each: true,
    message: 'Cada canal permitido debe ser MOSTRADOR, DOMICILIO o PEDIDOSYA.',
  })
  channels?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La prioridad debe ser un número entero.' })
  priority?: number;

  @IsOptional()
  @IsBoolean({ message: 'isActive debe ser booleano.' })
  isActive?: boolean;
}
