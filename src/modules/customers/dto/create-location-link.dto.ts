import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateLocationConfirmationLinkDto {
  @IsOptional()
  @IsString()
  businessId?: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  name: string;
}
