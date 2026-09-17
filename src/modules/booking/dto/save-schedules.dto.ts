import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ScheduleItemDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number; // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado

  @IsNotEmpty()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'startTime debe tener formato HH:mm (ej. 09:00)',
  })
  startTime: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'endTime debe tener formato HH:mm (ej. 18:00)',
  })
  endTime: string;
}

export class SaveSchedulesDto {
  @IsOptional()
  @IsString()
  serviceId?: string; // null/undefined para horario general

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  schedules: ScheduleItemDto[];
}
