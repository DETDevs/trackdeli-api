import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateApprovalDto {
  @IsString()
  @IsNotEmpty()
  action: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;
}
