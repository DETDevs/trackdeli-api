import { IsOptional, IsString } from 'class-validator';

export class GetClientVersionQueryDto {
  @IsOptional()
  @IsString()
  platform?: string;
}
