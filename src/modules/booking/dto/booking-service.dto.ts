import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateBookingServiceDto {
  @SanitizeText()
  @IsNotEmpty({ message: 'El nombre del servicio es obligatorio' })
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsNotEmpty({ message: 'La duración en minutos es obligatoria' })
  @IsInt()
  @Min(5, { message: 'La duración mínima es de 5 minutos' })
  durationMinutes: number;

  @IsNotEmpty({ message: 'El precio es obligatorio' })
  @IsNumber()
  @Min(0, { message: 'El precio no puede ser negativo' })
  price: number;

  @IsOptional()
  @IsBoolean()
  hasCustomSchedule?: boolean;
}

export class UpdateBookingServiceDto {
  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  durationMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  hasCustomSchedule?: boolean;
}
