import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;
}

