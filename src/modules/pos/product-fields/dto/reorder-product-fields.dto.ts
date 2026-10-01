import { ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ReorderProductFieldsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  fieldIds: string[];
}
