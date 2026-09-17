import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateBookingSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(168)
  minCancellationHours?: number;

  @IsOptional()
  @IsBoolean()
  trackNoShows?: boolean;

  @IsOptional()
  @IsBoolean()
  autoBlockAfterNoShows?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  noShowThreshold?: number;
}
