import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { MembershipType } from '@prisma/client';
import { Type } from 'class-transformer';

export class PreviewMembershipDto {
  @IsEnum(['CONTINUE', 'TODAY', 'CUSTOM'])
  @IsOptional()
  startMode?: 'CONTINUE' | 'TODAY' | 'CUSTOM';

  @IsString()
  @IsOptional()
  startDate?: string;

  @IsEnum(MembershipType)
  @IsOptional()
  type?: MembershipType;

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  trialDays?: number;
}

