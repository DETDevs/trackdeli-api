import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/** Mensaje y código estándar al intentar operar con un producto padre de variantes. */
export function assertNotVariantParent(
  product: { isVariantParent?: boolean } | null | undefined,
): void {
  if (product?.isVariantParent) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'VARIANT_PARENT_NOT_SELLABLE',
      message: 'Elegí la talla o el color antes de agregarlo.',
    });
  }
}

/** Normaliza texto de valores de variante para comparaciones insensibles a tildes y mayúsculas. */
export function normalizeVariantText(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/** Construye el nombre del hijo en el formato "Padre · Valor · Valor". */
export function buildVariantName(
  parentName: string,
  axesOrder: string[],
  variantValues: Record<string, string> | null | undefined,
): string {
  const values =
    variantValues && typeof variantValues === 'object' && !Array.isArray(variantValues)
      ? variantValues
      : {};
  const orderedParts: string[] = [];
  const usedKeys = new Set<string>();

  for (const key of axesOrder || []) {
    if (values[key] !== undefined && values[key] !== null && String(values[key]).trim() !== '') {
      orderedParts.push(String(values[key]).trim());
      usedKeys.add(key);
    }
  }

  const remainingKeys = Object.keys(values)
    .filter((k) => !usedKeys.has(k))
    .sort();
  for (const key of remainingKeys) {
    const raw = values[key];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      orderedParts.push(String(raw).trim());
    }
  }

  const base = (parentName || '').trim();
  if (orderedParts.length === 0) {
    return base.substring(0, 200);
  }
  return `${base} · ${orderedParts.join(' · ')}`.substring(0, 200);
}

/** Clave canónica estable para detectar combinaciones ya existentes de variantes. */
export function canonicalVariantKey(
  variantValues: Record<string, string> | null | undefined,
): string {
  const obj =
    variantValues && typeof variantValues === 'object' && !Array.isArray(variantValues)
      ? variantValues
      : {};
  const sortedKeys = Object.keys(obj).sort();
  return JSON.stringify(
    sortedKeys.map((k) => [k, normalizeVariantText(String(obj[k] ?? ''))]),
  );
}

/** Indica si el rol tiene permiso para ver costos de variantes/productos. */
export function canViewVariantCost(userRole?: string): boolean {
  return (
    userRole !== UserRole.CAJERO &&
    userRole !== UserRole.WAITER &&
    userRole !== UserRole.VENDEDOR
  );
}

/** Resumen de variante incluido en el listado agrupado (?groupVariants=true). */
export function formatVariantSummary(variant: any, userRole?: string) {
  const variantValues =
    variant.variantValues &&
    typeof variant.variantValues === 'object' &&
    !Array.isArray(variant.variantValues)
      ? variant.variantValues
      : {};

  return {
    id: variant.id,
    name: variant.name,
    variantValues,
    price: Number(variant.price),
    ...(canViewVariantCost(userRole)
      ? { cost: variant.cost != null ? Number(variant.cost) : null }
      : {}),
    stock: variant.stock != null ? Number(variant.stock) : 0,
    barcode: variant.barcode ?? null,
    sku: variant.sku ?? null,
    imageUrl: variant.imageUrl ?? null,
    isActive: Boolean(variant.isActive),
  };
}

/** Detalle completo de variante devuelto por los endpoints /pos/products/:id/variants. */
export function formatVariantDetail(variant: any, userRole?: string) {
  return {
    ...formatVariantSummary(variant, userRole),
    parentProductId: variant.parentProductId ?? null,
    unit: variant.unit || 'UND',
    minStock: variant.minStock != null ? Number(variant.minStock) : 0,
    maxStock: variant.maxStock != null ? Number(variant.maxStock) : null,
    taxable: Boolean(variant.taxable),
    taxIncluded: Boolean(variant.taxIncluded),
    allowDiscount: variant.allowDiscount !== false,
    categoryId: variant.categoryId ?? null,
    attributes:
      variant.attributes &&
      typeof variant.attributes === 'object' &&
      !Array.isArray(variant.attributes)
        ? variant.attributes
        : {},
    createdAt: variant.createdAt,
    updatedAt: variant.updatedAt,
  };
}
