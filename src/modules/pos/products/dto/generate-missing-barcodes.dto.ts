import { IsBoolean, IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class GenerateMissingBarcodesDto {
  @IsOptional()
  @IsBoolean({ message: 'El parámetro dryRun debe ser verdadero o falso.' })
  dryRun?: boolean = true;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El límite debe ser un número entero.' })
  limit?: number;
}
