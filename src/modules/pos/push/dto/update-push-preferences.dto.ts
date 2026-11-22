import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ALL_PUSH_CATEGORIES, PushCategory } from '../push.constants';

const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class PushPreferenceItemDto {
  @IsIn(ALL_PUSH_CATEGORIES, {
    message: 'La categoría de notificación no es válida.',
  })
  category: PushCategory;

  @IsBoolean({ message: 'El campo enabled debe ser booleano.' })
  enabled: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @Matches(HH_MM_REGEX, {
    message: 'quietStart debe tener el formato HH:mm (ej. 22:00).',
  })
  quietStart?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @Matches(HH_MM_REGEX, {
    message: 'quietEnd debe tener el formato HH:mm (ej. 07:00).',
  })
  quietEnd?: string | null;
}

export class UpdatePushPreferencesDto {
  @IsOptional()
  @IsArray({ message: 'preferences debe ser una lista.' })
  @ValidateNested({ each: true })
  @Type(() => PushPreferenceItemDto)
  preferences?: PushPreferenceItemDto[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @Matches(HH_MM_REGEX, {
    message: 'quietStart debe tener el formato HH:mm (ej. 22:00).',
  })
  quietStart?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @Matches(HH_MM_REGEX, {
    message: 'quietEnd debe tener el formato HH:mm (ej. 07:00).',
  })
  quietEnd?: string | null;
}
