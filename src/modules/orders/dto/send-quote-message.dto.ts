import { IsString, MaxLength, MinLength } from 'class-validator';

export class SendQuoteMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message: string;
}