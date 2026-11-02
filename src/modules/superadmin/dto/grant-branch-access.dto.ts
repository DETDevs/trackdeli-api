import { IsNotEmpty, IsString } from 'class-validator';

export class GrantBranchAccessDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  businessId: string;
}

