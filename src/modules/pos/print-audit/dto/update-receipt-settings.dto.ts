import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateReceiptSettingsDto {
  @IsOptional()
  @IsString()
  logoImage?: string | null;

  @IsOptional()
  @IsBoolean()
  showLogo?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4, { message: 'El encabezado puede tener un máximo de 4 líneas' })
  @IsString({ each: true })
  @MaxLength(48, { each: true, message: 'Cada línea de encabezado puede tener un máximo de 48 caracteres' })
  headerLines?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4, { message: 'El pie de página puede tener un máximo de 4 líneas' })
  @IsString({ each: true })
  @MaxLength(48, { each: true, message: 'Cada línea de pie de página puede tener un máximo de 48 caracteres' })
  footerLines?: string[];

  @IsOptional()
  @IsBoolean()
  showBusinessName?: boolean;

  @IsOptional()
  @IsBoolean()
  showAddress?: boolean;

  @IsOptional()
  @IsBoolean()
  showPhone?: boolean;

  @IsOptional()
  @IsBoolean()
  showTaxId?: boolean;

  @IsOptional()
  @IsBoolean()
  showCashier?: boolean;

  @IsOptional()
  @IsBoolean()
  showCustomer?: boolean;

  @IsOptional()
  @IsBoolean()
  showTaxBreakdown?: boolean;

  @IsOptional()
  @IsBoolean()
  showBatches?: boolean;

  @IsOptional()
  @IsIn([58, 80], { message: 'paperWidthMm solo puede ser 58 u 80' })
  paperWidthMm?: number;
}
