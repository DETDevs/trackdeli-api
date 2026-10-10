import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class UpdateWorkshopCustomerDto {
  @IsOptional()
  @IsString({ message: 'El nombre debe ser un texto' })
  @Length(2, 100, { message: 'El nombre debe tener entre 2 y 100 caracteres' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto' })
  @MaxLength(30, { message: 'El teléfono no puede exceder 30 caracteres' })
  phone?: string | null;
}
