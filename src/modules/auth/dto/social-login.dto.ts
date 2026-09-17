import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class SocialLoginDto {
  @IsString()
  @IsNotEmpty()
  idToken: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['GOOGLE', 'APPLE'])
  provider: 'GOOGLE' | 'APPLE';
}
