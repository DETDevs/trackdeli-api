import { IsNotEmpty, IsString } from 'class-validator';

export class MergeFieldOptionDto {
  @IsString({ message: 'El ID de la opción destino debe ser una cadena de texto' })
  @IsNotEmpty({ message: 'El ID de la opción destino es obligatorio' })
  targetOptionId: string;
}
