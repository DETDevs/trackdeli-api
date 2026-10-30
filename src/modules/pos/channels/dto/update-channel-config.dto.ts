import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DeliveryChannelConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  defaultFee?: number;

  @IsOptional()
  @IsBoolean()
  taxable?: boolean | null;

  @IsOptional()
  @IsBoolean()
  requireDriver?: boolean;
}

export class PedidosYaChannelConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  taxPct?: number;

  @IsOptional()
  @IsIn(['RECARGO', 'MANTENER_GANANCIA', 'MISMO_PRECIO'])
  priceMode?: string;

  @IsOptional()
  @IsIn(['SIN_REDONDEO', 'REDONDEO_0_50', 'REDONDEO_1', 'REDONDEO_5'])
  rounding?: string;

  @IsOptional()
  @IsBoolean()
  capAtListPrice?: boolean;

  @IsOptional()
  @IsBoolean()
  requireOrderNumber?: boolean;
}

export class UpdateChannelConfigDto {
  // Configuración anidada (opcional)
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryChannelConfigDto)
  delivery?: DeliveryChannelConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PedidosYaChannelConfigDto)
  pedidosYa?: PedidosYaChannelConfigDto;

  // Propiedades planas (opcional para conveniencia)
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deliveryDefaultFee?: number;

  @IsOptional()
  @IsBoolean()
  deliveryTaxable?: boolean | null;

  @IsOptional()
  @IsBoolean()
  deliveryRequireDriver?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  pedidosYaCommissionPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  pedidosYaTaxPct?: number;

  @IsOptional()
  @IsIn(['RECARGO', 'MANTENER_GANANCIA', 'MISMO_PRECIO'])
  pedidosYaPriceMode?: string;

  @IsOptional()
  @IsIn(['SIN_REDONDEO', 'REDONDEO_0_50', 'REDONDEO_1', 'REDONDEO_5'])
  pedidosYaRounding?: string;

  @IsOptional()
  @IsBoolean()
  pedidosYaCapAtListPrice?: boolean;

  @IsOptional()
  @IsBoolean()
  pedidosYaRequireOrderNumber?: boolean;
}
