import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BulkProductFiltersDto {
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BulkProductChangesDto {
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  @Max(1000)
  markupPct?: number | null;
}

export class BulkUpdateProductsDto {
  @ValidateIf((o) => typeof o.productIds !== 'string' || o.productIds !== 'ALL_FILTERED')
  @IsArray({ message: 'productIds debe ser un arreglo de IDs o "ALL_FILTERED"' })
  @IsString({ each: true, message: 'Cada elemento de productIds debe ser un ID string' })
  productIds: string[] | 'ALL_FILTERED';

  @IsOptional()
  @ValidateNested()
  @Type(() => BulkProductFiltersDto)
  filters?: BulkProductFiltersDto;

  @ValidateNested()
  @Type(() => BulkProductChangesDto)
  changes: BulkProductChangesDto;
}
