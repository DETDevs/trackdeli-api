import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterPushTokenDto {
  @IsNotEmpty({ message: 'El token FCM es requerido.' })
  @IsString({ message: 'El token FCM debe ser un texto válido.' })
  @MaxLength(512, { message: 'El token FCM excede la longitud permitida.' })
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  appVersion?: string;

  @IsOptional()
  @IsIn(['android', 'ios'], {
    message: 'La plataforma debe ser android o ios.',
  })
  platform?: 'android' | 'ios';
}
