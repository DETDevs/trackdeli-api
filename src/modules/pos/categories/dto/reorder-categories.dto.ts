import { ArrayNotEmpty, IsArray, IsOptional, IsString } from 'class-validator';

export class ReorderCategoriesDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids?: string[];
}
