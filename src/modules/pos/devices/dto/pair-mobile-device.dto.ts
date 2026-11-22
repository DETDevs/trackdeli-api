import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { SanitizeText } from '../../../../common/decorators/sanitize-text.decorator';

export class PairMobileDeviceDto {
  @IsNotEmpty()
  @IsString()
  code: string;

  @IsNotEmpty()
  @IsString()
  deviceId: string;

  @IsOptional()
  @SanitizeText()
  @IsString()
  deviceName?: string;

  @IsOptional()
  @IsString()
  platform?: string;
}
