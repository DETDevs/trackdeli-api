import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class ReorderSalonZonesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids: string[];
}
