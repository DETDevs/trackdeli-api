import { IsOptional, IsString, IsArray } from 'class-validator';

export class SendToKitchenDto {
  @IsOptional()
  @IsString()
  clientRequestId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];
}
