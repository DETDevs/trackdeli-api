import { IsNotEmpty, IsIn } from 'class-validator';

export class UpdateKitchenSettingsDto {
  @IsNotEmpty({ message: 'El modo de cocina es obligatorio' })
  @IsIn(['NONE', 'PRINT'], { message: 'Modo de cocina no válido. Solo se permite NONE o PRINT' })
  mode: string;
}
