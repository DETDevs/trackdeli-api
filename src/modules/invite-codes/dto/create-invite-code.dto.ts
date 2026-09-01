import { IsDateString, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateInviteCodeDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  description?: string; // "Para riders zona norte"

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number; // null = ilimitado

  @IsOptional()
  @IsDateString()
  expiresAt?: string; // null = no expira
}
