import { IsDateString, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateInviteCodeDto {
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  code?: string; // si no se pasa, se genera automáticamente

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
