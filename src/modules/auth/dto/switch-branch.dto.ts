import { IsNotEmpty, IsString } from 'class-validator';

export class SwitchBranchDto {
  @IsString()
  @IsNotEmpty()
  businessId: string;
}

