import { Injectable, UnprocessableEntityException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProductsService } from './products.service';
import { BatchesService } from '../batches/batches.service';
import { ProductFieldDataType, StockMovementType, Prisma, UserRole } from '@prisma/client';
import * as exceljs from 'exceljs';
import { parse } from 'csv-parse/sync';
import { normalizeOptionLabel } from '../../../common/utils/field-key.util';

export interface ImportTarget {
  id: string;
  label: string;
  kind: 'core' | 'dynamic';
  dataType: string;
  required: boolean;
  options?: string[];
}

export interface AnalyzeResult {
  sheets: string[];
  selectedSheet: string;
  headerRow: number;
  headers: string[];
  sampleRows: any[][];
  suggestedMapping: Record<string, { target: string | 'ignore' | 'append_description' }>;
  targets: ImportTarget[];
}

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  errors: { row: number; column: string; message: string }[];
  warnings: { row: number; column: string; message: string }[];
  ignoredColumns: string[];
  totalRows: number;
}

const TYPE_OPTIONS = ['PRODUCTO', 'SERVICIO'];

const CORE_TARGETS: ImportTarget[] = [
  { id: 'type', label: 'Tipo (PRODUCTO/SERVICIO)', kind: 'core', dataType: 'SELECT', options: TYPE_OPTIONS, required: false },
  { id: 'sku', label: 'SKU', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'barcode', label: 'Código de Barras', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'name', label: 'Nombre del Producto', kind: 'core', dataType: 'TEXT', required: true },
  { id: 'description', label: 'Descripción', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'categoryId', label: 'Categoría', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'price', label: 'Precio', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'cost', label: 'Costo', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'listPrice', label: 'Precio Etiqueta', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'markupPct', label: 'Margen %', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'taxable', label: 'Aplica IVA (SI/NO)', kind: 'core', dataType: 'BOOLEAN', required: false },
  { id: 'taxIncluded', label: 'Impuesto Incluido', kind: 'core', dataType: 'BOOLEAN', required: false },
  { id: 'trackStock', label: 'Controla Inventario', kind: 'core', dataType: 'BOOLEAN', required: false },
  { id: 'stock', label: 'Existencia (Stock)', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'minStock', label: 'Stock Mínimo', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'maxStock', label: 'Stock Máximo', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'unit', label: 'Unidad de Medida', kind: 'core', dataType: 'SELECT', options: ['UND', 'LT', 'GAL', 'KG', 'LB'], required: false },
  { id: 'supplierId', label: 'Proveedor', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'wholesalePrice', label: 'Precio por Mayor', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'wholesaleMinQty', label: 'Cantidad Mínima por Mayor', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'sendToKitchen', label: 'Enviar a Cocina (SI/NO)', kind: 'core', dataType: 'BOOLEAN', required: false },
  { id: 'isActive', label: 'Activo', kind: 'core', dataType: 'BOOLEAN', required: false },
];

/** Configuración del negocio que decide qué columnas ve (igual que el formulario de producto). */
export interface TargetVisibilityConfig {
  isPharmacy: boolean;
  isRestaurant: boolean;
  useListPrice: boolean;
  wholesaleEnabled: boolean;
}

/**
 * Filtra las columnas base según el negocio, replicando las reglas del formulario
 * "Nuevo producto" (pos-desktop ProductModal.tsx):
 * - Descripción e Impuesto Incluido no se editan por producto en el formulario → fuera.
 * - Precio Etiqueta solo si el negocio usa precio etiqueta o es farmacia.
 * - Unidad de Medida y Stock Máximo se ocultan en farmacia.
 * - Precio/Cantidad por Mayor solo si la venta por mayor está habilitada.
 * - Enviar a Cocina solo en restaurante.
 */
export function filterCoreTargets(cfg: TargetVisibilityConfig): ImportTarget[] {
  return CORE_TARGETS.filter((t) => {
    switch (t.id) {
      case 'description':
      case 'taxIncluded':
        return false;
      case 'listPrice':
        return cfg.useListPrice || cfg.isPharmacy;
      case 'unit':
      case 'maxStock':
        return !cfg.isPharmacy;
      case 'wholesalePrice':
      case 'wholesaleMinQty':
        return cfg.wholesaleEnabled;
      case 'sendToKitchen':
        return cfg.isRestaurant;
      default:
        return true;
    }
  });
}

const PHARMACY_FIELD_KEYS = ['laboratorio', 'principio_activo', 'presentacion'];

@Injectable()
export class ProductsImportService {
  private readonly logger = new Logger(ProductsImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly batchesService: BatchesService,
  ) { }

  private normalizeStr(str: any): string {
    if (!str) return '';
    return String(str).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  private parseTolerantNumber(val: any): number {
    if (typeof val === 'number') return val;
    if (!val) return NaN;
    let str = String(val).toUpperCase();
    str = str.replace(/C\$/g, '').replace(/\$/g, '').replace(/NIO/g, '').replace(/USD/g, '').trim();

    // Contar comas y puntos
    const commas = (str.match(/,/g) || []).length;
    const periods = (str.match(/\./g) || []).length;

    if (commas > 0 && periods === 0) {
      str = str.replace(/,/g, '.');
    } else if (commas > 0 && periods > 0) {
      const lastComma = str.lastIndexOf(',');
      const lastPeriod = str.lastIndexOf('.');
      if (lastComma > lastPeriod) {
        str = str.replace(/\./g, '').replace(',', '.');
      } else {
        str = str.replace(/,/g, '');
      }
    }
    return parseFloat(str);
  }

  private isRowEmpty(row: any[]): boolean {
    return !row || row.every((c) => c === null || c === undefined || String(c).trim() === '');
  }

  private unwrapExcelCellValue(val: any): any {
    if (val === null || val === undefined || val instanceof Date) return val;
    if (typeof val === 'object') {
      if ('result' in val) {
        const res = (val as any).result;
        if (res && typeof res === 'object' && 'error' in res) return '';
        return res ?? '';
      }
      if (Array.isArray((val as any).richText)) {
        return (val as any).richText.map((r: any) => r?.text ?? '').join('');
      }
      if ('text' in val) {
        return this.unwrapExcelCellValue((val as any).text);
      }
    }
    return val;
  }

  private async normalizeXlsxBuffer(fileBuffer: Buffer): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fileBuffer);
    let modified = false;
    for (const [name, entry] of Object.entries<any>(zip.files)) {
      if (!entry.dir && (name.endsWith('.xml') || name.endsWith('.rels'))) {
        const content: string = await entry.async('string');
        const cleaned = content
          .replace(/^\uFEFF/, '')
          .replace(/<x:/g, '<')
          .replace(/<\/x:/g, '</')
          .replace(/\s+xmlns:x=/g, ' xmlns=');
        if (cleaned !== content) {
          zip.file(name, cleaned);
          modified = true;
        }
      }
    }
    return modified ? await zip.generateAsync({ type: 'nodebuffer' }) : fileBuffer;
  }

  private async loadExcelWorkbook(fileBuffer: Buffer): Promise<exceljs.Workbook> {
    const workbook = new exceljs.Workbook();
    try {
      await workbook.xlsx.load(fileBuffer as any);
      if (workbook.worksheets.length > 0) {
        return workbook;
      }
    } catch {
      // Fallback below for OpenXML files using explicit `x:` namespace prefix or BOM
    }
    const normalizedBuffer = await this.normalizeXlsxBuffer(fileBuffer);
    const fallbackWorkbook = new exceljs.Workbook();
    await fallbackWorkbook.xlsx.load(normalizedBuffer as any);
    return fallbackWorkbook;
  }

  private isEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true; // loose equality checks null == undefined
    if (a == null || b == null) return false;

    // Normalize dates to YYYY-MM-DD
    if (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a)) a = a.substring(0, 10);
    if (typeof b === 'string' && /^\d{4}-\d{2}-\d{2}/.test(b)) b = b.substring(0, 10);

    // Normalize number vs string
    if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
    if (typeof b === 'number' && typeof a === 'string') return b === Number(a);

    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const k of keysA) {
        if (!this.isEqual(a[k], b[k])) return false;
      }
      return true;
    }
    return a === b;
  }

  /**
   * Columnas del negocio. Por defecto devuelve solo las que el formulario de producto
   * muestra para ese negocio (plantilla, exportación y mapeo). Con `includeHidden`
   * devuelve todas las base, para que la importación siga aceptando archivos viejos.
   */
  async getTargets(businessId: string, opts?: { includeHidden?: boolean }): Promise<ImportTarget[]> {
    const [fields, business] = await Promise.all([
      this.prisma.productFieldDefinition.findMany({
        where: { businessId, isActive: true },
        orderBy: { order: 'asc' },
      }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: {
          tracksBatches: true,
          posVertical: true,
          useListPrice: true,
          wholesaleEnabled: true,
          industry: { select: { code: true } },
        },
      }),
    ]);

    const dynamicTargets: ImportTarget[] = fields
      .filter((f) => !f.key?.endsWith('_id'))
      .map((f) => ({
        id: f.key,
        label: f.label,
        kind: 'dynamic',
        dataType: f.dataType,
        required: f.required,
        options: f.options as string[],
      }));

    const batchTargets: ImportTarget[] = business?.tracksBatches
      ? [
        { id: 'lotNumber', label: 'Lote', kind: 'core', dataType: 'TEXT', required: false },
        { id: 'expiryDate', label: 'Fecha de Vencimiento', kind: 'core', dataType: 'DATE', required: false },
      ]
      : [];

    const isPharmacy =
      (business as any)?.industry?.code?.toLowerCase() === 'farmacia' ||
      fields.some((f) => PHARMACY_FIELD_KEYS.includes((f.key || '').toLowerCase()));

    const coreTargets = opts?.includeHidden
      ? CORE_TARGETS
      : filterCoreTargets({
        isPharmacy,
        isRestaurant: (business as any)?.posVertical === 'RESTAURANTE',
        useListPrice: Boolean((business as any)?.useListPrice),
        wholesaleEnabled: Boolean((business as any)?.wholesaleEnabled),
      });

    return [...coreTargets, ...batchTargets, ...dynamicTargets];
  }

  async analyzeFile(businessId: string, fileBuffer: Buffer, mimetype: string, originalname: string): Promise<AnalyzeResult> {
    const isCsv = originalname.toLowerCase().endsWith('.csv') || mimetype.includes('csv');
    const isExcel = originalname.toLowerCase().endsWith('.xlsx') || mimetype.includes('spreadsheetml');

    if (originalname.toLowerCase().endsWith('.xls') && !isExcel) {
      throw new BadRequestException('Formato antiguo .xls no soportado. Por favor, Guardar como .xlsx');
    }

    if (!isCsv && !isExcel) {
      throw new BadRequestException('Solo se soportan archivos .xlsx o .csv');
    }

    let rows: any[][] = [];
    let sheets: string[] = ['Hoja 1'];

    if (isCsv) {
      try {
        rows = parse(fileBuffer, { skip_empty_lines: true, relax_column_count: true });
      } catch (e) {
        throw new BadRequestException('Error al parsear archivo CSV');
      }
    } else {
      try {
        const workbook = await this.loadExcelWorkbook(fileBuffer);
        sheets = workbook.worksheets.map(ws => ws.name);
        const ws = workbook.worksheets[0];
        ws.eachRow((row, rowNumber) => {
          rows.push(row.values as any[]);
        });
        // exceljs row.values uses 1-based array, index 0 is empty
        rows = rows.map(r => {
          const arr = [...r];
          arr.shift();
          return arr.map(c => this.unwrapExcelCellValue(c));
        });
      } catch (e) {
        throw new BadRequestException('Error al parsear archivo Excel. Verifique que sea un .xlsx válido.');
      }
    }

    if (rows.length === 0) {
      throw new BadRequestException('El archivo está vacío');
    }

    let headerRowIdx = 0;
    let headers: string[] = [];
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const row = rows[i];
      if (this.isRowEmpty(row)) continue;

      const textCount = row.filter(c => typeof c === 'string' && c.trim().length > 0).length;
      if (textCount >= 2) {
        headerRowIdx = i;
        headers = row.map(c => c ? String(c).trim() : '');
        break;
      }
    }

    if (headers.length === 0) {
      throw new BadRequestException('No se pudieron detectar encabezados en el archivo');
    }

    // Al mapear un archivo se aceptan todas las columnas base (archivos propios o exportaciones viejas).
    const targets = await this.getTargets(businessId, { includeHidden: true });

    const suggestedMapping: Record<string, { target: string | 'ignore' | 'append_description' }> = {};
    const usedTargets = new Set<string>();

    const aliases: Record<string, string[]> = {
      type: ['tipo de producto', 'tipo de item', 'producto o servicio', 'producto/servicio'],
      sendToKitchen: ['enviar a cocina'],
      name: ['nombre', 'producto', 'articulo', 'item', 'descripcion corta'],
      price: ['precio', 'p. venta', 'pvp', 'precio venta', 'price'],
      cost: ['costo', 'p. costo', 'precio costo'],
      stock: ['stock', 'existencia', 'cantidad', 'inventario'],
      categoryId: ['categoria', 'rubro', 'familia', 'departamento', 'linea'],
      sku: ['codigo', 'sku', 'ref', 'referencia', 'cod'],
      barcode: ['codigo de barras', 'ean', 'upc', 'barcode'],
      description: ['descripcion', 'detalle', 'observaciones'],
      minStock: ['stock minimo', 'minimo'],
      maxStock: ['stock maximo', 'maximo'],
      supplierId: ['proveedor'],
      wholesalePrice: ['precio por mayor', 'precio mayor', 'p. mayor', 'p mayor', 'mayor', 'precio mayorista'],
      wholesaleMinQty: ['cantidad minima por mayor', 'cantidad minima mayor', 'cant minima mayor', 'minimo mayor', 'cant min mayor', 'min mayor'],
      lotNumber: ['lote', 'batch', 'nro lote', 'numero lote', 'no lote'],
      expiryDate: ['fecha de vencimiento', 'vencimiento', 'fecha vencimiento', 'caducidad', 'vence', 'expiracion'],
    };

    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (!h) continue;
      const colName = `col_${i}`;
      const normH = this.normalizeStr(h);
      let matchedTarget = '';

      // 1. Exact match first (core label/aliases or dynamic label/id)
      for (const t of targets) {
        if (usedTargets.has(t.id)) continue;
        if (t.kind === 'core' && (this.normalizeStr(t.label) === normH || aliases[t.id]?.some(a => this.normalizeStr(a) === normH))) {
          matchedTarget = t.id;
          break;
        } else if (t.kind === 'dynamic' && (normH === this.normalizeStr(t.label) || normH === this.normalizeStr(t.id))) {
          matchedTarget = t.id;
          break;
        }
      }

      // 2. Substring match prioritizing longer alias phrases
      if (!matchedTarget) {
        let bestTarget = '';
        let bestMatchLen = 0;
        for (const t of targets) {
          if (usedTargets.has(t.id)) continue;
          if (t.kind === 'core' && aliases[t.id]) {
            for (const a of aliases[t.id]) {
              const normA = this.normalizeStr(a);
              if (normH.includes(normA) && normA.length > bestMatchLen) {
                bestMatchLen = normA.length;
                bestTarget = t.id;
              }
            }
          }
        }
        if (bestTarget) {
          matchedTarget = bestTarget;
        }
      }

      if (matchedTarget) {
        suggestedMapping[colName] = { target: matchedTarget };
        usedTargets.add(matchedTarget);
      } else {
        suggestedMapping[colName] = { target: 'ignore' };
      }
    }

    // Attempt to load remembered mapping from DB (Optional, requires new table or redis, omitting for now to meet time constraints. Using suggestion algorithm only)

    const sampleRows = rows.slice(headerRowIdx + 1, headerRowIdx + 6);

    return {
      sheets,
      selectedSheet: sheets[0],
      headerRow: headerRowIdx + 1,
      headers,
      sampleRows,
      suggestedMapping,
      targets,
    };
  }

  async importFile(
    businessId: string,
    userId: string,
    fileBuffer: Buffer,
    mimetype: string,
    originalname: string,
    mapping: Record<string, { target: string | 'ignore' | 'append_description' }>,
    sheetName: string,
    headerRow: number,
    dryRun: boolean
  ): Promise<ImportResult> {

    // ... Parsing similar to analyze
    const isCsv = originalname.toLowerCase().endsWith('.csv') || mimetype.includes('csv');
    let rows: any[][] = [];

    if (isCsv) {
      rows = parse(fileBuffer, { skip_empty_lines: true, relax_column_count: true });
    } else {
      const workbook = await this.loadExcelWorkbook(fileBuffer);
      const ws = workbook.getWorksheet(sheetName) || workbook.worksheets[0];
      ws.eachRow((row, rowNumber) => {
        rows.push(row.values as any[]);
      });
      rows = rows.map(r => {
        const arr = Array.isArray(r) ? [...r] : Object.values(r);
        arr.shift();
        return arr.map(c => this.unwrapExcelCellValue(c));
      });
      // console.log("EXCEL ROWS:", rows);
    }

    const dataRows = rows.slice(headerRow);
    if (dataRows.length > 5000) {
      throw new BadRequestException('El archivo excede el límite de 5,000 filas.');
    }

    const headers = rows[headerRow - 1] || [];

    const [targets, business] = await Promise.all([
      this.getTargets(businessId, { includeHidden: true }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true, wholesaleEnabled: true, tracksBatches: true, industry: { select: { code: true } } },
      }),
    ]);
    const targetMap = new Map(targets.map(t => [t.id, t]));

    if (business?.industry?.code === 'farmacia') {
      await this.productsService.ensurePharmacyFieldDefinitions(businessId);
    }

    for (const [colKey, conf] of Object.entries(mapping)) {
      if (conf?.target && conf.target !== 'ignore' && conf.target !== 'append_description') {
        if (conf.target.endsWith('_id') && !['categoryId', 'supplierId'].includes(conf.target)) {
          throw new BadRequestException('El sufijo _id está reservado');
        }
        const tgt = targetMap.get(conf.target);
        if (tgt && tgt.kind === 'dynamic' && tgt.id.endsWith('_id')) {
          throw new BadRequestException('El sufijo _id está reservado');
        }
      }
    }
    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      include: { fieldOptions: true },
    });
    const inactiveFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: false },
      include: { fieldOptions: true },
    });
    const activeFieldMap = new Map(activeFields.map((f) => [f.key, f]));
    const inactiveFieldMap = new Map(inactiveFields.map((f) => [f.key, f]));

    const existingProducts = await this.prisma.product.findMany({ where: { businessId } });
    const productBySku = new Map<string, any>();
    const productByName = new Map<string, any>();
    for (const p of existingProducts) {
      if (p.sku) productBySku.set(this.normalizeStr(p.sku), p);
      productByName.set(this.normalizeStr(p.name), p);
    }

    const categories = await this.prisma.category.findMany({ where: { businessId } });
    const categoryByName = new Map(categories.map(c => [this.normalizeStr(c.name), c]));

    const suppliers = await this.prisma.supplier.findMany({ where: { businessId } });
    const supplierByName = new Map(suppliers.map(s => [this.normalizeStr(s.name), s]));

    const result: ImportResult = { created: 0, updated: 0, unchanged: 0, errors: [], warnings: [], ignoredColumns: [], totalRows: dataRows.length };

    const toCreate: any[] = [];
    const toUpdate: any[] = [];

    const processedSkus = new Set<string>();
    const processedNames = new Set<string>();

    for (let rIdx = 0; rIdx < dataRows.length; rIdx++) {
      const row = dataRows[rIdx];
      if (this.isRowEmpty(row)) continue;
      const rowNum = headerRow + rIdx + 1;

      const payload: any = { core: { taxIncluded: false, trackStock: true, isActive: true }, dynamic: {}, appendDesc: [] };
      let rowError = null;

      for (let cIdx = 0; cIdx < headers.length; cIdx++) {
        const h = headers[cIdx];
        if (!h) continue;
        const colKey = `col_${cIdx}`;
        const mapConf = mapping[colKey];
        if (!mapConf || mapConf.target === 'ignore') continue;
        const rawVal = row[cIdx];
        let valStr = typeof rawVal === 'object' && rawVal instanceof Date
          ? rawVal.toISOString()
          : rawVal !== undefined && rawVal !== null ? String(rawVal).trim() : '';

        if (valStr.startsWith("'") && valStr.length > 1 && /^[=+\-@]/.test(valStr.charAt(1))) {
          valStr = valStr.substring(1);
        }

        if (mapConf.target === 'append_description') {
          if (valStr) payload.appendDesc.push(`${h}: ${valStr}`);
          continue;
        }

        const tgt = targetMap.get(mapConf.target);
        if (!tgt) continue;

        let parsedVal: any = valStr;
        if (valStr !== '') {
          if (tgt.id === 'stock' || tgt.id === 'minStock' || tgt.id === 'maxStock') {
            parsedVal = this.parseTolerantNumber(valStr);
            if (isNaN(parsedVal)) {
              rowError = `Columna '${h}': debe ser un número.`;
              break;
            }
            if (parsedVal < 0) {
              rowError = `Columna '${h}': no puede ser negativo.`;
              break;
            }
            parsedVal = Math.round(parsedVal * 1000) / 1000;
          } else if (tgt.id === 'price' || tgt.id === 'cost' || tgt.id === 'listPrice') {
            parsedVal = this.parseTolerantNumber(valStr);
            if (isNaN(parsedVal) || parsedVal < 0) {
              rowError = `Columna '${h}': debe ser un número mayor o igual a 0.`;
              break;
            }
          } else if (tgt.id === 'markupPct') {
            parsedVal = this.parseTolerantNumber(valStr);
            if (isNaN(parsedVal) || parsedVal < 0 || parsedVal > 1000) {
              rowError = `Columna '${h}': debe ser un número entre 0 y 1000.`;
              break;
            }
          } else if (tgt.id === 'wholesalePrice') {
            parsedVal = this.parseTolerantNumber(valStr);
            if (isNaN(parsedVal) || parsedVal <= 0) {
              rowError = `Columna '${h}': debe ser un número mayor a 0.`;
              break;
            }
          } else if (tgt.id === 'wholesaleMinQty') {
            parsedVal = this.parseTolerantNumber(valStr);
            if (isNaN(parsedVal) || parsedVal < 2) {
              rowError = `Columna '${h}': debe ser un número mayor o igual a 2.`;
              break;
            }
            parsedVal = Math.round(parsedVal * 1000) / 1000;
          } else if (tgt.id === 'type') {
            const low = this.normalizeStr(valStr);
            if (['producto', 'product', 'prod'].includes(low)) parsedVal = 'PRODUCT';
            else if (low.startsWith('servicio') || ['service', 'combo'].includes(low)) parsedVal = 'SERVICE';
            else {
              rowError = `Columna '${h}': usá PRODUCTO o SERVICIO.`;
              break;
            }
          } else if (tgt.dataType === 'NUMBER') {
            parsedVal = this.parseTolerantNumber(valStr);
            if (isNaN(parsedVal)) {
              rowError = `Columna '${h}': debe ser un número.`;
              break;
            }
          } else if (tgt.dataType === 'BOOLEAN') {
            const low = this.normalizeStr(valStr);
            parsedVal = ['si', 'sí', 'yes', 'true', '1'].includes(low);
          } else if (tgt.dataType === 'DATE') {
            let d = new Date(valStr);
            if (isNaN(d.getTime())) {
              const num = Number(valStr);
              if (!isNaN(num)) {
                d = new Date((num - (25567 + 2)) * 86400 * 1000);
              }
            }
            if (isNaN(d.getTime())) {
              rowError = `Columna '${h}': formato de fecha inválido.`;
              break;
            }
            parsedVal = d.toISOString().split('T')[0];
          } else if (tgt.dataType === 'SELECT' && tgt.options) {
            const canonic = tgt.options.find(o => this.normalizeStr(o) === this.normalizeStr(valStr));
            if (!canonic) {
              rowError = `Valor '${valStr}' no está en las opciones permitidas de '${h}'.`;
              break;
            }
            parsedVal = canonic;
          } else if (tgt.dataType === 'LIST') {
            const field = activeFieldMap.get(tgt.id);
            if (field) {
              const normVal = normalizeOptionLabel(valStr);
              field.fieldOptions = field.fieldOptions || [];
              const matched = field.fieldOptions.find(
                (o: any) => o.normalizedLabel === normVal || o.label.toLowerCase() === valStr.toLowerCase(),
              );
              if (matched) {
                parsedVal = matched.label;
                payload.dynamic[`${tgt.id}_id`] = matched.id;
              } else {
                if (!(field.allowCreateInline ?? true)) {
                  rowError = `Columna '${h}': la opción '${valStr}' no existe para el campo '${field.label}' y no está permitida la creación al vuelo.`;
                  break;
                }
                let optId = `inline_${Date.now()}_${Math.random()}`;
                if (!dryRun) {
                  const last = await this.prisma.productFieldOption.findFirst({
                    where: { businessId, fieldDefinitionId: field.id },
                    orderBy: { sortOrder: 'desc' },
                    select: { sortOrder: true },
                  });
                  const nextOrder = (last?.sortOrder ?? -1) + 1;
                  const newOpt = await this.prisma.productFieldOption.create({
                    data: {
                      businessId,
                      fieldDefinitionId: field.id,
                      label: valStr,
                      normalizedLabel: normVal,
                      sortOrder: nextOrder,
                      isActive: true,
                    },
                  });
                  optId = newOpt.id;
                  field.fieldOptions.push(newOpt);
                } else {
                  field.fieldOptions.push({
                    id: optId,
                    businessId,
                    fieldDefinitionId: field.id,
                    label: valStr,
                    normalizedLabel: normVal,
                    isActive: true,
                    sortOrder: 0,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  });
                }
                parsedVal = valStr;
                payload.dynamic[`${tgt.id}_id`] = optId;
              }
            }
          }
        } else {
          parsedVal = undefined;
        }

        if (parsedVal !== undefined) {
          if (tgt.kind === 'core') payload.core[tgt.id] = parsedVal;
          else payload.dynamic[tgt.id] = parsedVal;
        }
      }

      if (rowError) {
        result.errors.push({ row: rowNum, column: '', message: rowError });
        continue;
      }

      if (!payload.core.name) {
        result.errors.push({ row: rowNum, column: 'name', message: 'El nombre del producto es obligatorio.' });
        continue;
      }
      if (payload.core.price === undefined) {
        if (payload.core.cost !== undefined && payload.core.markupPct !== undefined) {
          payload.core.price = Math.round((Number(payload.core.cost) * (1 + Number(payload.core.markupPct) / 100)) * 100) / 100;
        } else {
          result.errors.push({ row: rowNum, column: 'price', message: 'El precio es obligatorio si no se especifica costo y margen.' });
          continue;
        }
      }

      const skuKey = payload.core.sku ? this.normalizeStr(payload.core.sku) : '';
      const nameKey = this.normalizeStr(payload.core.name);

      // Igual que el formulario: un SERVICIO no controla inventario.
      if (payload.core.type === 'SERVICE') {
        payload.core.trackStock = false;
        delete payload.core.stock;
        delete payload.core.minStock;
        delete payload.core.maxStock;
      }

      if ((skuKey && processedSkus.has(skuKey)) || processedNames.has(nameKey)) {
        result.errors.push({ row: rowNum, column: '', message: 'Fila duplicada en el archivo de importación.' });
        continue;
      }
      if (skuKey) processedSkus.add(skuKey);
      processedNames.add(nameKey);

      let existing = skuKey ? productBySku.get(skuKey) : productByName.get(nameKey);
      if (!existing && !skuKey) existing = productByName.get(nameKey);

      const hasWholesalePrice = payload.core.wholesalePrice !== undefined && payload.core.wholesalePrice !== null;
      const hasWholesaleMinQty = payload.core.wholesaleMinQty !== undefined && payload.core.wholesaleMinQty !== null;

      if (hasWholesalePrice || hasWholesaleMinQty) {
        if (!business?.wholesaleEnabled) {
          result.errors.push({
            row: rowNum,
            column: 'wholesalePrice',
            message: 'Venta por mayor no está habilitada para este negocio.',
          });
          continue;
        }

        if (!hasWholesalePrice || !hasWholesaleMinQty) {
          result.errors.push({
            row: rowNum,
            column: !hasWholesalePrice ? 'wholesalePrice' : 'wholesaleMinQty',
            message: 'Debe especificar tanto el precio por mayor como la cantidad mínima.',
          });
          continue;
        }

        const effectivePrice = payload.core.price !== undefined
          ? payload.core.price
          : (existing ? Number(existing.price) : undefined);

        if (effectivePrice !== undefined && payload.core.wholesalePrice >= effectivePrice) {
          result.errors.push({
            row: rowNum,
            column: 'wholesalePrice',
            message: 'El precio por mayor debe ser menor al precio normal.',
          });
          continue;
        }
      }

      if (payload.core.categoryId && typeof payload.core.categoryId === 'string') {
        const catName = payload.core.categoryId.trim();
        const catNorm = this.normalizeStr(catName);
        let cat = categoryByName.get(catNorm);
        if (!cat && !dryRun) {
          cat = await this.prisma.category.create({ data: { businessId, name: catName } });
          categoryByName.set(catNorm, cat);
        }
        payload.core.categoryId = cat?.id || null;
      }

      if (payload.core.supplierId && typeof payload.core.supplierId === 'string') {
        const supName = payload.core.supplierId.trim();
        const sup = supplierByName.get(this.normalizeStr(supName));
        if (!sup) {
          result.warnings.push({ row: rowNum, column: 'supplierId', message: `Proveedor '${supName}' no encontrado. Se dejó vacío.` });
          payload.core.supplierId = null;
        } else {
          payload.core.supplierId = sup.id;
        }
      }

      if (payload.appendDesc.length > 0) {
        payload.core.description = [payload.core.description || existing?.description || '', ...payload.appendDesc].filter(Boolean).join(' \n');
      }

      let lotNumber: string | null = null;
      let expiryDate: Date | null = null;
      if (payload.core.lotNumber !== undefined) {
        lotNumber = payload.core.lotNumber ? String(payload.core.lotNumber).trim() : null;
        delete payload.core.lotNumber;
      }
      if (payload.core.expiryDate !== undefined) {
        expiryDate = payload.core.expiryDate ? new Date(payload.core.expiryDate) : null;
        delete payload.core.expiryDate;
      }

      if (business?.tracksBatches) {
        if (lotNumber || expiryDate) {
          payload.core.tracksBatches = true;
        } else if (existing?.tracksBatches && payload.core.trackStock !== false && payload.core.stock !== undefined && payload.core.stock > 0) {
          payload.core.tracksBatches = true;
          result.warnings.push({
            row: rowNum,
            column: 'lotNumber',
            message: 'Producto con existencias sin lote especificado: se asignará al lote INICIAL.',
          });
        }
      }

      try {
        const existingAttrs = existing ? (typeof existing.attributes === 'object' ? existing.attributes : {}) : {};
        const mergedAttrs = this.productsService.validateAttributesSync(payload.dynamic, existingAttrs, activeFieldMap, inactiveFieldMap);

        if (existing) {
          const coreUpdate = { ...payload.core };
          // Check stock diff
          let stockDiff = 0;
          const currentStockNum = existing.stock !== undefined && existing.stock !== null ? Number(existing.stock) : 0;
          if (coreUpdate.trackStock !== false && coreUpdate.stock !== undefined && currentStockNum !== coreUpdate.stock) {
            stockDiff = Math.round((coreUpdate.stock - currentStockNum) * 1000) / 1000;
          }

          let isUnchanged = true;
          for (const k of Object.keys(coreUpdate)) {
            if (!this.isEqual(coreUpdate[k], (existing as any)[k])) {
              isUnchanged = false;
              break;
            }
          }
          if (isUnchanged && !this.isEqual(mergedAttrs, existingAttrs)) {
            isUnchanged = false;
          }

          if (isUnchanged) {
            result.unchanged++;
          } else {
            toUpdate.push({ id: existing.id, rowNum, data: { ...coreUpdate, attributes: mergedAttrs }, stockDiff, oldStock: currentStockNum, lotNumber, expiryDate });
          }
        } else {
          if (business?.industry?.code === 'farmacia') {
            if (!payload.core.unit) {
              payload.core.unit = 'UND';
            }
            const productType = (payload.core.type || 'PRODUCT').trim().toUpperCase();
            if (productType === 'PRODUCT') {
              const missingInRow: { column: string; label: string }[] = [];
              if (!payload.core.name || !String(payload.core.name).trim()) {
                missingInRow.push({ column: 'name', label: 'Nombre' });
              }
              if (!mergedAttrs?.laboratorio || !String(mergedAttrs.laboratorio).trim()) {
                missingInRow.push({ column: 'laboratorio', label: 'Laboratorio' });
              }
              if (!mergedAttrs?.presentacion || !String(mergedAttrs.presentacion).trim()) {
                missingInRow.push({ column: 'presentacion', label: 'Presentación' });
              }
              if (!mergedAttrs?.principio_activo || !String(mergedAttrs.principio_activo).trim()) {
                missingInRow.push({ column: 'principio_activo', label: 'Principio activo' });
              }
              if (payload.core.listPrice == null || Number(payload.core.listPrice) <= 0 || isNaN(Number(payload.core.listPrice))) {
                missingInRow.push({ column: 'listPrice', label: 'Precio de etiqueta' });
              }
              if (payload.core.cost == null || Number(payload.core.cost) <= 0 || isNaN(Number(payload.core.cost))) {
                missingInRow.push({ column: 'cost', label: 'Costo' });
              }
              if (payload.core.price == null || Number(payload.core.price) <= 0 || isNaN(Number(payload.core.price))) {
                missingInRow.push({ column: 'price', label: 'Precio de venta' });
              }
              if (payload.core.stock == null || Number(payload.core.stock) < 0 || isNaN(Number(payload.core.stock))) {
                missingInRow.push({ column: 'stock', label: 'Stock actual' });
              }
              if (payload.core.minStock == null || Number(payload.core.minStock) < 0 || isNaN(Number(payload.core.minStock))) {
                missingInRow.push({ column: 'minStock', label: 'Stock mínimo' });
              }
              if (!payload.core.supplierId) {
                missingInRow.push({ column: 'supplierId', label: 'Proveedor' });
              }

              if (missingInRow.length > 0) {
                for (const m of missingInRow) {
                  result.errors.push({
                    row: rowNum,
                    column: m.column,
                    message: `El campo '${m.label}' es obligatorio para el rubro farmacia`,
                  });
                }
                continue;
              }
            }
          }
          toCreate.push({ rowNum, data: { ...payload.core, attributes: mergedAttrs, businessId }, lotNumber, expiryDate });
        }
      } catch (e: any) {
        result.errors.push({ row: rowNum, column: '', message: e.message || 'Error validando atributos.' });
      }
    }

    if (!dryRun) {
      await this.prisma.$transaction(async (tx) => {
        for (const item of toCreate) {
          const p = await tx.product.create({ data: item.data });
          const stockNum = Number(p.stock);
          if (p.trackStock && stockNum > 0) {
            let batchId: string | null = null;
            if (business?.tracksBatches && p.tracksBatches) {
              if (item.lotNumber) {
                const batch = await this.batchesService.receive(tx, {
                  businessId,
                  productId: p.id,
                  batchNumber: item.lotNumber,
                  expiryDate: item.expiryDate,
                  qty: stockNum,
                  cost: p.cost ? Number(p.cost) : null,
                });
                batchId = batch.id;
              } else {
                const batch = await this.batchesService.ensureInitialBatch(
                  tx,
                  businessId,
                  p.id,
                  stockNum,
                  p.cost ? Number(p.cost) : null,
                );
                batchId = batch?.id || null;
              }
            }
            await tx.stockMovement.create({
              data: {
                businessId,
                productId: p.id,
                userId,
                type: StockMovementType.INITIAL,
                quantity: p.stock,
                stockBefore: 0,
                stockAfter: p.stock,
                concept: 'Importación de catálogo (inicial)',
                batchId,
              },
            });
          }
          result.created++;
        }
        for (const item of toUpdate) {
          const p = await tx.product.update({ where: { id: item.id }, data: item.data });
          if (item.stockDiff !== 0) {
            let batchId: string | null = null;
            if (business?.tracksBatches && p.tracksBatches) {
              if (item.stockDiff > 0) {
                if (item.lotNumber) {
                  const batch = await this.batchesService.receive(tx, {
                    businessId,
                    productId: p.id,
                    batchNumber: item.lotNumber,
                    expiryDate: item.expiryDate,
                    qty: item.stockDiff,
                    cost: p.cost ? Number(p.cost) : null,
                  });
                  batchId = batch.id;
                } else {
                  const adj = await this.batchesService.adjust(tx, {
                    businessId,
                    productId: p.id,
                    delta: item.stockDiff,
                  });
                  batchId = adj?.batchId || null;
                }
              } else {
                const adj = await this.batchesService.adjust(tx, {
                  businessId,
                  productId: p.id,
                  delta: item.stockDiff,
                });
                batchId = adj?.batchId || null;
              }
            }
            await tx.stockMovement.create({
              data: {
                businessId,
                productId: p.id,
                userId,
                type: StockMovementType.AJUSTE,
                quantity: item.stockDiff,
                stockBefore: item.oldStock,
                stockAfter: p.stock,
                concept: 'Importación de catálogo (edición manual)',
                batchId,
              },
            });
          } else if (business?.tracksBatches && p.tracksBatches && item.lotNumber) {
            const currentStock = Number(p.stock);
            if (currentStock > 0) {
              const existingBatch = await tx.productBatch.findFirst({
                where: { businessId, productId: p.id, batchNumber: item.lotNumber },
              });
              if (!existingBatch) {
                await this.batchesService.receive(tx, {
                  businessId,
                  productId: p.id,
                  batchNumber: item.lotNumber,
                  expiryDate: item.expiryDate,
                  qty: currentStock,
                  cost: p.cost ? Number(p.cost) : null,
                });
              }
            }
          }
          result.updated++;
        }
      });
    } else {
      result.created = toCreate.length;
      result.updated = toUpdate.length;
    }

    return result;
  }

  async generateTemplate(businessId: string | null, industryId?: string): Promise<exceljs.Workbook> {
    const workbook = new exceljs.Workbook();
    const ws = workbook.addWorksheet('Plantilla de Productos');
    const wsHelp = workbook.addWorksheet('Instrucciones');

    let targets: ImportTarget[] = [];
    if (businessId) {
      targets = await this.getTargets(businessId);
    } else if (industryId) {
      const ind = await this.prisma.industry.findUnique({ where: { id: industryId }, include: { fieldTemplates: { orderBy: { order: 'asc' } } } });
      if (!ind) throw new BadRequestException('Industria no encontrada');
      const isTracksBatches = ind.tracksBatches || ind.code === 'farmacia';
      const batchTargets: ImportTarget[] = isTracksBatches
        ? [
          { id: 'lotNumber', label: 'Lote', kind: 'core', dataType: 'TEXT', required: false },
          { id: 'expiryDate', label: 'Fecha de Vencimiento', kind: 'core', dataType: 'DATE', required: false },
        ]
        : [];
      targets = [...filterCoreTargets({
        isPharmacy: ind.code === 'farmacia',
        isRestaurant: ind.posVertical === 'RESTAURANTE',
        useListPrice: false,
        wholesaleEnabled: false,
      }), ...batchTargets, ...ind.fieldTemplates.map(f => ({
        id: f.key, label: f.label, kind: 'dynamic' as const, dataType: f.dataType, required: f.required, options: f.options as string[]
      }))];
    } else {
      throw new BadRequestException('Debe proveer businessId o industryId');
    }

    // Set columns
    ws.columns = targets.map(t => ({ header: t.label, key: t.id, width: 20 }));

    // Add sample row
    const sampleRow: any = {};
    for (const t of targets) {
      if (t.id === 'name') sampleRow[t.id] = 'Producto de ejemplo';
      else if (t.id === 'type') sampleRow[t.id] = 'PRODUCTO';
      else if (t.id === 'unit') sampleRow[t.id] = 'UND';
      else if (t.id === 'minStock') sampleRow[t.id] = 5;
      else if (t.id === 'sku') sampleRow[t.id] = "'10001"; // Prefix with quote to avoid number format
      else if (t.id === 'barcode') sampleRow[t.id] = "'123456789012";
      else if (t.id === 'price') sampleRow[t.id] = 100.50;
      else if (t.id === 'cost') sampleRow[t.id] = 50.00;
      else if (t.id === 'wholesalePrice') sampleRow[t.id] = 85.00;
      else if (t.id === 'wholesaleMinQty') sampleRow[t.id] = 6;
      else if (t.id === 'listPrice') sampleRow[t.id] = 120.00;
      else if (t.id === 'markupPct') sampleRow[t.id] = 25.00;
      else if (t.id === 'taxable') sampleRow[t.id] = 'NO';
      else if (t.id === 'trackStock' || t.id === 'taxIncluded' || t.id === 'isActive' || t.id === 'sendToKitchen') sampleRow[t.id] = 'SI';
      else if (t.id === 'stock') sampleRow[t.id] = 10;
      else if (t.id === 'lotNumber') sampleRow[t.id] = 'LT-2026-001';
      else if (t.id === 'expiryDate') sampleRow[t.id] = '2026-12-31';
      else if (t.dataType === 'BOOLEAN') sampleRow[t.id] = 'SI';
      else if (t.dataType === 'NUMBER') sampleRow[t.id] = 1;
      else if (t.dataType === 'DATE') sampleRow[t.id] = '2026-10-01';
      else if (t.dataType === 'SELECT' && t.options?.length) sampleRow[t.id] = t.options[0];
      else if (t.dataType === 'TEXT') sampleRow[t.id] = 'Texto de ejemplo';
    }
    ws.addRow(sampleRow);

    // Help Sheet
    wsHelp.columns = [
      { header: 'Columna', key: 'col', width: 25 },
      { header: 'Obligatorio', key: 'req', width: 15 },
      { header: 'Tipo / Opciones', key: 'type', width: 40 },
      { header: 'Descripción', key: 'desc', width: 60 }
    ];
    for (const t of targets) {
      let typeStr = t.dataType;
      if (t.dataType === 'SELECT') typeStr = `Opciones: ${t.options?.join(', ')}`;
      if (t.dataType === 'BOOLEAN') typeStr = 'SI / NO';
      let desc = '...';
      if (t.id === 'wholesalePrice') desc = 'Precio por mayor (opcional, menor al precio normal)';
      else if (t.id === 'wholesaleMinQty') desc = 'Cantidad mínima para precio por mayor (mínimo 2)';
      else if (t.id === 'listPrice') desc = 'Precio de etiqueta o referencia (opcional).';
      else if (t.id === 'markupPct') desc = 'Margen de ganancia sobre costo en % (opcional, ej. 25).';
      else if (t.id === 'taxable') desc = 'Aplica 15% de IVA sobre precio de venta (SI o NO, defecto NO).';
      else if (t.id === 'type') desc = 'PRODUCTO (controla inventario) o SERVICIO (no controla inventario). Defecto PRODUCTO.';
      else if (t.id === 'sendToKitchen') desc = 'Si el producto se manda a cocina al pedirlo (SI o NO, defecto SI).';
      else if (t.id === 'lotNumber') desc = 'Número o código de lote (opcional). Si se omite y hay existencias, se asignará al lote INICIAL.';
      else if (t.id === 'expiryDate') desc = 'Fecha de vencimiento en formato AAAA-MM-DD o serial de Excel (opcional).';
      wsHelp.addRow({ col: t.label, req: t.required ? 'Sí' : 'No', type: typeStr, desc });
    }

    return workbook;
  }

  async exportProducts(businessId: string, filters?: any, userRole?: string): Promise<exceljs.Workbook> {
    const workbook = new exceljs.Workbook();
    const ws = workbook.addWorksheet('Productos');
    const targets = await this.getTargets(businessId);

    ws.columns = targets.map(t => ({
      header: t.label,
      key: t.id,
      width: 20,
      style: (t.id === 'sku' || t.id === 'barcode') ? { numFmt: '@' } : undefined
    }));

    let products: any[];
    if (this.productsService?.findAll && filters && Object.keys(filters).length > 0) {
      const { businessId: _, ...restFilters } = filters;
      products = await this.productsService.findAll(businessId, restFilters, userRole);
    } else {
      products = await this.prisma.product.findMany({
        where: { businessId, isActive: true },
        include: {
          category: true,
          supplier: true,
          batches: { where: { quantity: { gt: 0 } }, orderBy: { expiryDate: 'asc' } },
        }
      });
      if (userRole === UserRole.CAJERO || userRole === UserRole.WAITER) {
        for (const p of products) {
          delete (p as any).cost;
        }
      }
    }

    for (const p of products) {
      const row: any = {};
      const attrs = (typeof p.attributes === 'object' ? p.attributes : {}) as Record<string, any>;

      for (const t of targets) {
        if (t.kind === 'core') {
          if (t.id === 'categoryId') row[t.id] = p.category?.name || '';
          else if (t.id === 'supplierId') row[t.id] = p.supplier?.name || '';
          else if (t.id === 'sku' || t.id === 'barcode') row[t.id] = p[t.id] || '';
          else if (t.id === 'lotNumber') row[t.id] = (p as any).nextExpiryBatchCode || (p as any).batches?.[0]?.batchNumber || '';
          else if (t.id === 'expiryDate') {
            const exp = (p as any).nextExpiryDate || (p as any).batches?.[0]?.expiryDate;
            row[t.id] = exp ? (exp instanceof Date ? exp.toISOString().split('T')[0] : String(exp).split('T')[0]) : '';
          }
          else if (t.id === 'type') row[t.id] = (p as any).type === 'SERVICE' ? 'SERVICIO' : 'PRODUCTO';
          else if (t.id === 'trackStock' || t.id === 'taxIncluded' || t.id === 'isActive' || t.id === 'taxable' || t.id === 'sendToKitchen') {
            row[t.id] = (p as any)[t.id] ? 'SI' : 'NO';
          } else if (t.id === 'stock' || t.id === 'minStock' || t.id === 'maxStock' || t.id === 'wholesalePrice' || t.id === 'wholesaleMinQty') {
            // Decimal de Prisma → número para que Excel no lo guarde como texto
            const v = (p as any)[t.id];
            row[t.id] = v === null || v === undefined ? '' : Number(v);
          } else {
            row[t.id] = (p as any)[t.id];
          }
        } else {
          const v = attrs[t.id];
          if (t.dataType === 'BOOLEAN' && v !== undefined) row[t.id] = v ? 'SI' : 'NO';
          else row[t.id] = v;
        }

        if (typeof row[t.id] === 'string' && /^[=+\-@]/.test(row[t.id])) {
          row[t.id] = `'${row[t.id]}`;
        }
      }
      ws.addRow(row);
    }

    return workbook;
  }
}
