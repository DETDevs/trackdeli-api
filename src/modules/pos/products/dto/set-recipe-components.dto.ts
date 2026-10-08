import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsNumber, IsString, Min, ValidateNested } from 'class-validator';

export class RecipeComponentItemDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity: number;
}

export class SetRecipeComponentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeComponentItemDto)
  components: RecipeComponentItemDto[];
}
