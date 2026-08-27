import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MembershipStatus } from '@prisma/client';

export class MembershipsQueryDto {
  @IsString()
  @IsOptional()
  businessId?: string;

  @IsEnum(MembershipStatus)
  @IsOptional()
  status?: MembershipStatus;

  @IsString()
  @IsOptional()
  expiringSoon?: string;
}
