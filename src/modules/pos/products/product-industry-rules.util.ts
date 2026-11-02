import { BadRequestException } from '@nestjs/common';

export interface RequiredFieldDef {
  key: string;
  aliases?: string[];
  label: string;
  source: 'core' | 'attributes';
  type: 'text' | 'number_gt_zero' | 'number_gte_zero' | 'supplier';
}

export const REQUIRED_PRODUCT_FIELDS_BY_INDUSTRY: Record<string, RequiredFieldDef[]> = {
  farmacia: [
    { key: 'name', label: 'Nombre del producto', source: 'core', type: 'text' },
    { key: 'laboratorio', aliases: ['laboratory'], label: 'Laboratorio', source: 'attributes', type: 'text' },
    { key: 'presentacion', aliases: ['presentation'], label: 'Presentación', source: 'attributes', type: 'text' },
    { key: 'principio_activo', aliases: ['activeIngredient', 'active_ingredient'], label: 'Principio activo', source: 'attributes', type: 'text' },
    { key: 'listPrice', aliases: ['list_price'], label: 'Precio de etiqueta', source: 'core', type: 'number_gt_zero' },
    { key: 'cost', label: 'Costo', source: 'core', type: 'number_gt_zero' },
    { key: 'price', label: 'Precio de venta', source: 'core', type: 'number_gt_zero' },
    { key: 'stock', aliases: ['currentStock'], label: 'Stock actual', source: 'core', type: 'number_gte_zero' },
    { key: 'minStock', aliases: ['min_stock'], label: 'Stock mínimo', source: 'core', type: 'number_gte_zero' },
    { key: 'supplierId', aliases: ['supplier_id'], label: 'Proveedor', source: 'core', type: 'supplier' },
  ],
};

/**
 * Normaliza los campos de farmacia enviados en la raíz del DTO hacia attributes
 */
export function normalizePharmacyAttributes(dto: any): void {
  if (!dto || typeof dto !== 'object') return;
  dto.attributes = dto.attributes && typeof dto.attributes === 'object' && !Array.isArray(dto.attributes)
    ? { ...dto.attributes }
    : {};

  if (dto.laboratorio && !dto.attributes.laboratorio) dto.attributes.laboratorio = dto.laboratorio;
  if (dto.laboratory && !dto.attributes.laboratorio) dto.attributes.laboratorio = dto.laboratory;
  if (dto.presentacion && !dto.attributes.presentacion) dto.attributes.presentacion = dto.presentacion;
  if (dto.presentation && !dto.attributes.presentacion) dto.attributes.presentacion = dto.presentation;
  if (dto.principio_activo && !dto.attributes.principio_activo) dto.attributes.principio_activo = dto.principio_activo;
  if (dto.activeIngredient && !dto.attributes.principio_activo) dto.attributes.principio_activo = dto.activeIngredient;
  if (dto.active_ingredient && !dto.attributes.principio_activo) dto.attributes.principio_activo = dto.active_ingredient;
}

/**
 * Extrae el valor de un campo ya sea de core o de attributes
 */
export function getFieldValue(dto: any, rule: RequiredFieldDef): any {
  if (rule.source === 'attributes') {
    const attrs = dto.attributes && typeof dto.attributes === 'object' ? dto.attributes : {};
    let val = attrs[rule.key];
    if (val !== undefined && val !== null && val !== '') return val;
    if (rule.aliases) {
      for (const alias of rule.aliases) {
        val = attrs[alias];
        if (val !== undefined && val !== null && val !== '') return val;
      }
    }
    // Revisar también si vino en la raíz
    val = dto[rule.key];
    if (val !== undefined && val !== null && val !== '') return val;
    if (rule.aliases) {
      for (const alias of rule.aliases) {
        val = dto[alias];
        if (val !== undefined && val !== null && val !== '') return val;
      }
    }
    return undefined;
  }

  // source === 'core'
  let val = dto[rule.key];
  if (val !== undefined && val !== null && val !== '') return val;
  if (rule.aliases) {
    for (const alias of rule.aliases) {
      val = dto[alias];
      if (val !== undefined && val !== null && val !== '') return val;
    }
  }
  return val;
}

/**
 * Valida un valor individual según su tipo de regla
 */
export function isFieldValueValid(val: any, rule: RequiredFieldDef, supplierValid = true): boolean {
  if (val === undefined || val === null) return false;

  switch (rule.type) {
    case 'text':
      if (typeof val === 'string') return val.trim().length > 0;
      if (typeof val === 'object' && val !== null) {
        return Boolean(val.label || val.id || val.name);
      }
      return false;

    case 'number_gt_zero': {
      const num = typeof val === 'number' ? val : Number(val);
      return !isNaN(num) && num > 0;
    }

    case 'number_gte_zero': {
      const num = typeof val === 'number' ? val : Number(val);
      return !isNaN(num) && num >= 0;
    }

    case 'supplier': {
      const str = String(val).trim();
      return str.length > 0 && supplierValid;
    }

    default:
      return true;
  }
}

/**
 * Valida creación de producto según rubro de negocio.
 * Arroja BadRequestException con { code: 'PRODUCT_REQUIRED_FIELDS', fields: [...] } si falta alguno.
 */
export function validateProductCreationForIndustry(
  industryCode: string | undefined | null,
  productType: string | undefined | null,
  dto: any,
  supplierValid = true,
): void {
  const normIndustry = (industryCode || '').trim().toLowerCase();
  const rules = REQUIRED_PRODUCT_FIELDS_BY_INDUSTRY[normIndustry];
  if (!rules || rules.length === 0) return;

  const normType = (productType || dto.type || 'PRODUCT').trim().toUpperCase();
  if (normType !== 'PRODUCT') {
    // Servicios y combos no llevan laboratorio, presentación, principio activo, stock, proveedor ni costo obligatorios
    return;
  }

  normalizePharmacyAttributes(dto);

  const missingFields: string[] = [];

  for (const rule of rules) {
    const val = getFieldValue(dto, rule);
    const isValid = isFieldValueValid(val, rule, supplierValid);
    if (!isValid) {
      missingFields.push(rule.key);
    }
  }

  if (missingFields.length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'PRODUCT_REQUIRED_FIELDS',
      message: `Faltan campos obligatorios para el rubro ${normIndustry}`,
      fields: missingFields,
    });
  }
}

/**
 * Valida edición de producto según rubro de negocio.
 * Solo valida los campos que vienen en la petición (no permite dejar vacío un campo obligatorio).
 */
export function validateProductUpdateForIndustry(
  industryCode: string | undefined | null,
  productType: string | undefined | null,
  dto: any,
  supplierValid = true,
): void {
  const normIndustry = (industryCode || '').trim().toLowerCase();
  const rules = REQUIRED_PRODUCT_FIELDS_BY_INDUSTRY[normIndustry];
  if (!rules || rules.length === 0) return;

  const normType = (productType || dto.type || 'PRODUCT').trim().toUpperCase();
  if (normType !== 'PRODUCT') return;

  normalizePharmacyAttributes(dto);

  const invalidFields: string[] = [];

  for (const rule of rules) {
    // Verificar si el campo fue enviado en la petición
    let isProvided = false;
    let val: any = undefined;

    if (rule.source === 'attributes') {
      const attrs = dto.attributes;
      if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
        if (attrs[rule.key] !== undefined) {
          isProvided = true;
          val = attrs[rule.key];
        } else if (rule.aliases) {
          for (const alias of rule.aliases) {
            if (attrs[alias] !== undefined) {
              isProvided = true;
              val = attrs[alias];
              break;
            }
          }
        }
      }
      if (!isProvided) {
        if (dto[rule.key] !== undefined) {
          isProvided = true;
          val = dto[rule.key];
        } else if (rule.aliases) {
          for (const alias of rule.aliases) {
            if (dto[alias] !== undefined) {
              isProvided = true;
              val = dto[alias];
              break;
            }
          }
        }
      }
    } else {
      // core
      if (dto[rule.key] !== undefined) {
        isProvided = true;
        val = dto[rule.key];
      } else if (rule.aliases) {
        for (const alias of rule.aliases) {
          if (dto[alias] !== undefined) {
            isProvided = true;
            val = dto[alias];
            break;
          }
        }
      }
    }

    if (isProvided) {
      const isValid = isFieldValueValid(val, rule, supplierValid);
      if (!isValid) {
        invalidFields.push(rule.key);
      }
    }
  }

  if (invalidFields.length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'PRODUCT_REQUIRED_FIELDS',
      message: `Los siguientes campos obligatorios para el rubro ${normIndustry} no pueden dejarse vacíos o con valores no válidos: ${invalidFields.join(', ')}`,
      fields: invalidFields,
    });
  }
}

