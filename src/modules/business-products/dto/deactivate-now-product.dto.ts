import { IsNotEmpty, IsString } from 'class-validator';

export class DeactivateNowProductDto {
  @IsString()
  @IsNotEmpty({ message: 'El motivo del corte inmediato es obligatorio.' })
  reason: string;
}
