import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PosDeviceStatus } from '@prisma/client';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class UpdateDeviceDto {
  @IsOptional()
  @IsEnum(PosDeviceStatus)
  status?: PosDeviceStatus;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(100)
  name?: string;
}
