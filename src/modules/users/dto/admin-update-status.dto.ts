import { IsBoolean, IsNotEmpty } from 'class-validator';

export class AdminUpdateStatusDto {
  @IsBoolean()
  @IsNotEmpty()
  isActive: boolean;
}
