import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class BroadcastPushDto {
  @IsNotEmpty({ message: 'El título del aviso es requerido.' })
  @IsString({ message: 'El título debe ser un texto válido.' })
  @MaxLength(100, { message: 'El título no puede superar los 100 caracteres.' })
  title: string;

  @IsNotEmpty({ message: 'El contenido del aviso es requerido.' })
  @IsString({ message: 'El contenido debe ser un texto válido.' })
  @MaxLength(200, { message: 'El contenido no puede superar los 200 caracteres.' })
  body: string;

  @IsOptional()
  @IsArray({ message: 'businessIds debe ser una lista de IDs de negocios.' })
  @IsString({ each: true })
  businessIds?: string[];
}
