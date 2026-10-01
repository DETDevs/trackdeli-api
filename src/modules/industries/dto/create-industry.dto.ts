import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PosVertical } from '@prisma/client';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';

export class CreateIndustryDto {
  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code: string;

  @SanitizeText()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsEnum(PosVertical)
  posVertical?: PosVertical;

  @IsOptional()
  @IsBoolean()
  usesVariants?: boolean;

  @IsOptional()
  @IsBoolean()
  tracksBatches?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  order?: number;
}
