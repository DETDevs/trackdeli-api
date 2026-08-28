import { IsNumber, Min, Max, IsOptional, IsString, MaxLength, Length } from 'class-validator';

export class UpdatePosSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;

  @IsOptional()
  @IsString()
  @Length(1, 10)
  invoicePrefix?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  posAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  posPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  posFooter?: string;
}
