import { IsOptional, IsString } from 'class-validator';

export class BusinessesQueryDto {
  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  search?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  sortBy?: string;

  @IsString()
  @IsOptional()
  order?: 'asc' | 'desc';

  @IsString()
  @IsOptional()
  format?: 'object' | 'array';
}
