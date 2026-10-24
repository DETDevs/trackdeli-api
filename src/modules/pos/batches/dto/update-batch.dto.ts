import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  batchNumber?: string;

  @IsOptional()
  @IsDateString({}, { message: 'expiryDate debe ser una fecha válida (AAAA-MM-DD o ISO)' })
  expiryDate?: string | null;
}
