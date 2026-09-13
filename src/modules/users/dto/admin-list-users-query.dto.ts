import { IsOptional, IsString } from 'class-validator';

export class AdminListUsersQueryDto {
  @IsString()
  @IsOptional()
  businessId?: string;
}
