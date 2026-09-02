import { IsNotEmpty, IsString } from 'class-validator';

export class SearchCustomerDto {
  @IsString()
  @IsNotEmpty()
  q: string;
}
