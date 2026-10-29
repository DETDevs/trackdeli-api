import { IsOptional, IsString } from 'class-validator';

export class MoveCategoryProductsDto {
  @IsOptional()
  @IsString()
  targetCategoryId?: string | null;
}
