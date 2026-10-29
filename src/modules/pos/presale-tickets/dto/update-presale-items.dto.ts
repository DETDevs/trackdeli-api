import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UpdatePresaleItemActionDto {
  @IsEnum(['ADD', 'MODIFY', 'REMOVE'])
  action: 'ADD' | 'MODIFY' | 'REMOVE';

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  ticketItemId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class UpdatePresaleItemsDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdatePresaleItemActionDto)
  actions?: UpdatePresaleItemActionDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdatePresaleItemActionDto)
  items?: UpdatePresaleItemActionDto[];
}
