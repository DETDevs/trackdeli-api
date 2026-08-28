import { IsEnum, IsNumber, IsString, MinLength, Min } from 'class-validator';
import { MovementType } from '@prisma/client';

export class CashMovementDto {
  @IsEnum(MovementType)
  type: MovementType;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsString()
  @MinLength(3)
  concept: string;
}
