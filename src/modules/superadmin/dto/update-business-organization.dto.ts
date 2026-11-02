import { IsOptional, IsString } from 'class-validator';

export class UpdateBusinessOrganizationDto {
  @IsOptional()
  @IsString()
  organizationId?: string | null;
}

