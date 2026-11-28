import { IsNotEmpty, IsString } from 'class-validator';

export class AssignTableWaiterDto {
  @IsString({ message: 'El identificador del mesero debe ser texto.' })
  @IsNotEmpty({ message: 'El mesero es obligatorio.' })
  waiterId: string;
}
