import {
  IsOptional,
  IsString,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isValidSemver } from '../utils/semver.util';

@ValidatorConstraint({ name: 'isSemverOrEmpty', async: false })
export class IsSemverOrEmptyConstraint implements ValidatorConstraintInterface {
  validate(text: any, _args: ValidationArguments) {
    if (text === '' || text === null || text === undefined) return true;
    if (typeof text !== 'string') return false;
    return isValidSemver(text);
  }

  defaultMessage(_args: ValidationArguments) {
    return 'minVersion debe tener un formato semver válido (ej. 1.0.4 o 1.0.10) o estar vacío para remover restricción.';
  }
}

export class UpdateClientVersionDto {
  @IsString()
  @Validate(IsSemverOrEmptyConstraint)
  minVersion: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
