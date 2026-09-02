import { IsString, MaxLength, MinLength } from 'class-validator';

export class JoinBusinessDto {
  @IsString()
  @MinLength(4)
  @MaxLength(20)
  code: string;
}
