import { ALLOWED_PRODUCT_UNITS } from './product-unit.util';

export type AllowedUnitOfMeasure = (typeof ALLOWED_PRODUCT_UNITS)[number];

export interface SuggestedBaseUnit {
  name: string;
  plural: string;
  unitOfMeasure: AllowedUnitOfMeasure;
  allowsDecimals: boolean;
}

export interface SuggestedSaleForm {
  name: string;
  plural: string;
  contains: number | null;
  forBaseUnit: string | null;
}

export interface IndustrySaleUnitsConfig {
  baseUnits: SuggestedBaseUnit[];
  formSuggestions: SuggestedSaleForm[];
}

export type SaleUnitsProfileKey =
  | 'farmacia'
  | 'abarrotes'
  | 'ferreteria'
  | 'repuestos_taller'
  | 'restaurante'
  | 'default';

/**
 * 313a — Unidades base y formas de venta sugeridas por perfil de rubro.
 * Todos los `unitOfMeasure` pertenecen estrictamente a ALLOWED_PRODUCT_UNITS.
 * Cuando una unidad no tiene código propio en ALLOWED_PRODUCT_UNITS (ej. Tableta, Cápsula,
 * Pie, Par, Juego, Porción, Botella), se asigna 'UND' y allowsDecimals: false.
 */
export const SALE_UNITS_BY_PROFILE: Record<SaleUnitsProfileKey, IndustrySaleUnitsConfig> = {
  farmacia: {
    baseUnits: [
      { name: 'Tableta', plural: 'Tabletas', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Cápsula', plural: 'Cápsulas', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Sobre', plural: 'Sobres', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Frasco', plural: 'Frascos', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Unidad', plural: 'Unidades', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Mililitro', plural: 'Mililitros', unitOfMeasure: 'ML', allowsDecimals: true },
    ],
    formSuggestions: [
      { name: 'Blíster', plural: 'Blísters', contains: 10, forBaseUnit: null },
      { name: 'Caja', plural: 'Cajas', contains: 100, forBaseUnit: null },
    ],
  },

  abarrotes: {
    baseUnits: [
      { name: 'Unidad', plural: 'Unidades', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Libra', plural: 'Libras', unitOfMeasure: 'LB', allowsDecimals: true },
      { name: 'Kilo', plural: 'Kilos', unitOfMeasure: 'KG', allowsDecimals: true },
      { name: 'Litro', plural: 'Litros', unitOfMeasure: 'LT', allowsDecimals: true },
    ],
    formSuggestions: [
      { name: 'Quintal', plural: 'Quintales', contains: 100, forBaseUnit: 'Libra' },
      { name: 'Arroba', plural: 'Arrobas', contains: 25, forBaseUnit: 'Libra' },
      { name: 'Docena', plural: 'Docenas', contains: 12, forBaseUnit: 'Unidad' },
      { name: 'Fardo', plural: 'Fardos', contains: null, forBaseUnit: null },
      { name: 'Caja', plural: 'Cajas', contains: null, forBaseUnit: null },
      { name: 'Paquete', plural: 'Paquetes', contains: null, forBaseUnit: null },
    ],
  },

  ferreteria: {
    baseUnits: [
      { name: 'Unidad', plural: 'Unidades', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Libra', plural: 'Libras', unitOfMeasure: 'LB', allowsDecimals: true },
      { name: 'Metro', plural: 'Metros', unitOfMeasure: 'MT', allowsDecimals: true },
      { name: 'Pie', plural: 'Pies', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Galón', plural: 'Galones', unitOfMeasure: 'GAL', allowsDecimals: true },
      { name: 'Litro', plural: 'Litros', unitOfMeasure: 'LT', allowsDecimals: true },
    ],
    formSuggestions: [
      { name: 'Caja', plural: 'Cajas', contains: null, forBaseUnit: null },
      { name: 'Rollo', plural: 'Rollos', contains: null, forBaseUnit: null },
      { name: 'Cubeta', plural: 'Cubetas', contains: null, forBaseUnit: null },
      { name: 'Docena', plural: 'Docenas', contains: 12, forBaseUnit: 'Unidad' },
      { name: 'Quintal', plural: 'Quintales', contains: 100, forBaseUnit: 'Libra' },
    ],
  },

  repuestos_taller: {
    baseUnits: [
      { name: 'Unidad', plural: 'Unidades', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Par', plural: 'Pares', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Juego', plural: 'Juegos', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Litro', plural: 'Litros', unitOfMeasure: 'LT', allowsDecimals: true },
      { name: 'Galón', plural: 'Galones', unitOfMeasure: 'GAL', allowsDecimals: true },
    ],
    formSuggestions: [
      { name: 'Caja', plural: 'Cajas', contains: null, forBaseUnit: null },
      { name: 'Docena', plural: 'Docenas', contains: 12, forBaseUnit: 'Unidad' },
      { name: 'Juego', plural: 'Juegos', contains: null, forBaseUnit: null },
    ],
  },

  restaurante: {
    baseUnits: [
      { name: 'Unidad', plural: 'Unidades', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Porción', plural: 'Porciones', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Botella', plural: 'Botellas', unitOfMeasure: 'UND', allowsDecimals: false },
    ],
    formSuggestions: [
      { name: 'Cajilla', plural: 'Cajillas', contains: 24, forBaseUnit: 'Unidad' },
      { name: 'Caja', plural: 'Cajas', contains: null, forBaseUnit: null },
    ],
  },

  default: {
    baseUnits: [
      { name: 'Unidad', plural: 'Unidades', unitOfMeasure: 'UND', allowsDecimals: false },
      { name: 'Libra', plural: 'Libras', unitOfMeasure: 'LB', allowsDecimals: true },
      { name: 'Kilo', plural: 'Kilos', unitOfMeasure: 'KG', allowsDecimals: true },
      { name: 'Litro', plural: 'Litros', unitOfMeasure: 'LT', allowsDecimals: true },
      { name: 'Metro', plural: 'Metros', unitOfMeasure: 'MT', allowsDecimals: true },
    ],
    formSuggestions: [
      { name: 'Docena', plural: 'Docenas', contains: 12, forBaseUnit: 'Unidad' },
      { name: 'Caja', plural: 'Cajas', contains: null, forBaseUnit: null },
      { name: 'Paquete', plural: 'Paquetes', contains: null, forBaseUnit: null },
    ],
  },
};

/**
 * Mapeo explícito de `industries.code` (tabla `industries`) hacia el perfil de unidades.
 */
export const INDUSTRY_CODE_TO_SALE_UNITS_PROFILE: Record<string, SaleUnitsProfileKey> = {
  farmacia: 'farmacia',
  abarrotes: 'abarrotes',
  ferreteria: 'ferreteria',
  repuestos_motos: 'repuestos_taller',
  taller: 'repuestos_taller',
  restaurante: 'restaurante',
  general: 'default',
  cosmetica: 'default',
  ropa_calzado: 'default',
};

function normalizeRubroText(raw?: string | null): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function matchProfileByKeywords(text: string): SaleUnitsProfileKey | null {
  if (!text) return null;
  if (text.includes('farmacia') || text.includes('botica')) return 'farmacia';
  if (
    text.includes('abarrot') ||
    text.includes('pulperi') ||
    text.includes('mini market') ||
    text.includes('minimarket') ||
    text.includes('supermercad')
  ) {
    return 'abarrotes';
  }
  if (text.includes('ferreter')) return 'ferreteria';
  if (text.includes('repuest') || text.includes('taller')) return 'repuestos_taller';
  if (
    text.includes('restaur') ||
    text.includes('cafeter') ||
    text.includes('comedor') ||
    text.includes('pizzer') ||
    text.includes('comida') ||
    /\bbar\b/.test(text)
  ) {
    return 'restaurante';
  }
  return null;
}

/**
 * Resuelve `{ baseUnits, formSuggestions }` para un negocio a partir de su rubro (`industries.code`)
 * o, en negocios antiguos sin `industryId`, de su `type` / `posVertical`.
 * Si no tiene rubro o el rubro no está mapeado, devuelve la lista por defecto.
 */
export function resolveSaleUnitsForBusiness(params?: {
  industryCode?: string | null;
  industryName?: string | null;
  businessType?: string | null;
  posVertical?: string | null;
}): IndustrySaleUnitsConfig {
  let profileKey: SaleUnitsProfileKey = 'default';

  const codeNorm = normalizeRubroText(params?.industryCode);
  if (codeNorm) {
    profileKey =
      INDUSTRY_CODE_TO_SALE_UNITS_PROFILE[codeNorm] ||
      matchProfileByKeywords(codeNorm) ||
      matchProfileByKeywords(normalizeRubroText(params?.industryName)) ||
      'default';
  } else {
    const typeMatch = matchProfileByKeywords(normalizeRubroText(params?.businessType));
    if (typeMatch) {
      profileKey = typeMatch;
    } else if (normalizeRubroText(params?.posVertical) === 'restaurante') {
      profileKey = 'restaurante';
    }
  }

  const profile = SALE_UNITS_BY_PROFILE[profileKey] || SALE_UNITS_BY_PROFILE.default;
  return {
    baseUnits: profile.baseUnits.map((u) => ({ ...u })),
    formSuggestions: profile.formSuggestions.map((f) => ({ ...f })),
  };
}
