import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  ValidateNested,
  ArrayMaxSize,
  ArrayMinSize,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class BatchCountLineDto {
  @IsNotEmpty()
  @IsString()
  productId: string;

  @IsInt()
  @Min(0)
  countedQty: number;
}

export class BatchCountDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200, { message: 'El conteo por lotes no puede exceder las 200 líneas.' })
  @ValidateNested({ each: true })
  @Type(() => BatchCountLineDto)
  lines: BatchCountLineDto[];

  @IsNotEmpty({ message: 'El motivo del conteo es obligatorio' })
  @SanitizeText()
  @IsString()
  reason: string;
}
