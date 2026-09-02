import { IsNotEmpty, IsString } from 'class-validator';

export class LookupCustomerDto {
  @IsString()
  @IsNotEmpty()
  phone: string;
}
