import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateApprovalDto {
  @IsString()
  @IsNotEmpty()
  action: string;

  @IsString()
  @IsNotEmpty()
  approverEmail: string;

  @IsString()
  @IsNotEmpty()
  approverPassword: string;

  @IsOptional()
  @IsString()
  cashRegisterId?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;
}
