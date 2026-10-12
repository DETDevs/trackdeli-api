import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class MergeSubAccountsDto {
  @IsNotEmpty({ message: 'fromSubAccountId es requerido' })
  @IsString()
  fromSubAccountId: string;

  @IsNotEmpty({ message: 'toSubAccountId es requerido' })
  @IsString()
  toSubAccountId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  splitVersion?: number;
}
