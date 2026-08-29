import { IsString, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  quoteId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message: string;
}