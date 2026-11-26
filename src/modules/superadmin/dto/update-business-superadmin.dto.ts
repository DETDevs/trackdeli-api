import { Type, Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { UpdateBusinessDto } from '../../businesses/dto/update-business.dto';
import { SanitizeText } from '../../../common/decorators/sanitize-text.decorator';
import {
  ALLOWED_ACCOUNT_TYPES,
  BusinessAccountType,
} from '../utils/membership-billing.util';

const trimOrNull = ({ value }: { value: any }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  return value;
};

export class BusinessContactInputDto {
  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(150)
  name?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(80)
  role?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(30)
  whatsapp?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsEmail({}, { message: 'El correo del contacto no es válido.' })
  @MaxLength(150)
  email?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(100)
  municipality?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(100)
  department?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(40)
  taxId?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class SuperAdminUpdateBusinessDto extends UpdateBusinessDto {
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(ALLOWED_ACCOUNT_TYPES, {
    message: 'El tipo de cuenta debe ser CLIENTE, DEMO o INTERNO.',
  })
  accountType?: BusinessAccountType;

  @IsOptional()
  @SanitizeText()
  @IsString()
  @MaxLength(300)
  accountTypeReason?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BusinessContactInputDto)
  contact?: BusinessContactInputDto;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(150)
  contactName?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(80)
  contactRole?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(30)
  contactPhone?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(30)
  contactWhatsapp?: string | null;

  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsEmail({}, { message: 'El correo del contacto no es válido.' })
  @MaxLength(150)
  contactEmail?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(300)
  contactAddress?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(100)
  contactMunicipality?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(100)
  contactDepartment?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(40)
  contactTaxId?: string | null;

  @IsOptional()
  @SanitizeText()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  contactNotes?: string | null;
}
