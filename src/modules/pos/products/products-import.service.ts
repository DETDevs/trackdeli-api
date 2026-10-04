import { Injectable, UnprocessableEntityException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProductsService } from './products.service';
import { ProductFieldDataType, StockMovementType, Prisma } from '@prisma/client';
import * as exceljs from 'exceljs';
import { parse } from 'csv-parse/sync';

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

const CORE_TARGETS: ImportTarget[] = [
  { id: 'sku', label: 'SKU', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'barcode', label: 'Código de Barras', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'name', label: 'Nombre del Producto', kind: 'core', dataType: 'TEXT', required: true },
  { id: 'description', label: 'Descripción', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'categoryId', label: 'Categoría', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'price', label: 'Precio', kind: 'core', dataType: 'NUMBER', required: true },
  { id: 'cost', label: 'Costo', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'taxIncluded', label: 'Impuesto Incluido', kind: 'core', dataType: 'BOOLEAN', required: false },
  { id: 'trackStock', label: 'Controla Inventario', kind: 'core', dataType: 'BOOLEAN', required: false },
  { id: 'stock', label: 'Existencia (Stock)', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'minStock', label: 'Stock Mínimo', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'maxStock', label: 'Stock Máximo', kind: 'core', dataType: 'NUMBER', required: false },
  { id: 'supplierId', label: 'Proveedor', kind: 'core', dataType: 'TEXT', required: false },
  { id: 'isActive', label: 'Activo', kind: 'core', dataType: 'BOOLEAN', required: false },
];

@Injectable()
export class ProductsImportService {
  private readonly logger = new Logger(ProductsImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
  ) {}

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

  async getTargets(businessId: string): Promise<ImportTarget[]> {
    const fields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
      orderBy: { order: 'asc' },
    });
    
    const dynamicTargets: ImportTarget[] = fields.map((f) => ({
      id: f.key,
      label: f.label,
      kind: 'dynamic',
      dataType: f.dataType,
      required: f.required,
      options: f.options as string[],
    }));

    return [...CORE_TARGETS, ...dynamicTargets];
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
      const workbook = new exceljs.Workbook();
      try {
        await workbook.xlsx.load(fileBuffer as any);
        sheets = workbook.worksheets.map(ws => ws.name);
        const ws = workbook.worksheets[0];
        ws.eachRow((row, rowNumber) => {
          rows.push(row.values as any[]);
        });
        // exceljs row.values uses 1-based array, index 0 is empty
        rows = rows.map(r => {
          const arr = [...r];
          arr.shift(); 
          return arr;
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

    const targets = await this.getTargets(businessId);
    
    const suggestedMapping: Record<string, { target: string | 'ignore' | 'append_description' }> = {};
    const usedTargets = new Set<string>();

    const aliases: Record<string, string[]> = {
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
      supplierId: ['proveedor']
    };

    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (!h) continue;
      const colName = `col_${i}`;
      const normH = this.normalizeStr(h);
      let matchedTarget = '';

      for (const t of targets) {
        if (usedTargets.has(t.id)) continue;
        if (t.kind === 'core' && aliases[t.id]?.some(a => normH.includes(this.normalizeStr(a)))) {
          matchedTarget = t.id;
          break;
        } else if (t.kind === 'dynamic' && (normH === this.normalizeStr(t.label) || normH === this.normalizeStr(t.id))) {
          matchedTarget = t.id;
          break;
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
      const workbook = new exceljs.Workbook();
      await workbook.xlsx.load(fileBuffer as any);
      const ws = workbook.getWorksheet(sheetName) || workbook.worksheets[0];
      ws.eachRow((row, rowNumber) => {
        rows.push(row.values as any[]);
      });
      rows = rows.map(r => {
        const arr = Array.isArray(r) ? [...r] : Object.values(r);
        arr.shift();
        return arr;
      });
      // console.log("EXCEL ROWS:", rows);
    }

    const dataRows = rows.slice(headerRow);
    if (dataRows.length > 5000) {
      throw new BadRequestException('El archivo excede el límite de 5,000 filas.');
    }

    const headers = rows[headerRow - 1] || [];
    
    const targets = await this.getTargets(businessId);
    const targetMap = new Map(targets.map(t => [t.id, t]));
    
    
    const activeFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: true },
    });
    const inactiveFields = await this.prisma.productFieldDefinition.findMany({
      where: { businessId, isActive: false },
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
             if (isNaN(parsedVal) || !Number.isInteger(parsedVal)) {
               rowError = `Columna '${h}': debe ser un número entero.`;
               break;
             }
             if (parsedVal < 0) {
               rowError = `Columna '${h}': no puede ser negativo.`;
               break;
             }
          } else if (tgt.id === 'price' || tgt.id === 'cost') {
             parsedVal = this.parseTolerantNumber(valStr);
             if (isNaN(parsedVal) || parsedVal < 0) {
               rowError = `Columna '${h}': debe ser un número mayor o igual a 0.`;
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
            parsedVal = ['si','sí','yes','true','1'].includes(low);
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
        result.errors.push({ row: rowNum, column: 'price', message: 'El precio es obligatorio.' });
        continue;
      }

      const skuKey = payload.core.sku ? this.normalizeStr(payload.core.sku) : '';
      const nameKey = this.normalizeStr(payload.core.name);

      if ((skuKey && processedSkus.has(skuKey)) || processedNames.has(nameKey)) {
        result.errors.push({ row: rowNum, column: '', message: 'Fila duplicada en el archivo de importación.' });
        continue;
      }
      if (skuKey) processedSkus.add(skuKey);
      processedNames.add(nameKey);

      let existing = skuKey ? productBySku.get(skuKey) : productByName.get(nameKey);
      if (!existing && !skuKey) existing = productByName.get(nameKey);

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
        payload.core.description = [payload.core.description || existing?.description || '', ...payload.appendDesc].filter(Boolean).join(' \\n');
      }

      try {
        const existingAttrs = existing ? (typeof existing.attributes === 'object' ? existing.attributes : {}) : {};
        const mergedAttrs = this.productsService.validateAttributesSync(payload.dynamic, existingAttrs, activeFieldMap, inactiveFieldMap);
        
        if (existing) {
          const coreUpdate = { ...payload.core };
          // Check stock diff
          let stockDiff = 0;
          if (coreUpdate.trackStock !== false && coreUpdate.stock !== undefined && existing.stock !== coreUpdate.stock) {
             stockDiff = coreUpdate.stock - existing.stock;
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
            toUpdate.push({ id: existing.id, rowNum, data: { ...coreUpdate, attributes: mergedAttrs }, stockDiff, oldStock: existing.stock });
          }
        } else {
          toCreate.push({ rowNum, data: { ...payload.core, attributes: mergedAttrs, businessId } });
        }
      } catch (e: any) {
        result.errors.push({ row: rowNum, column: '', message: e.message || 'Error validando atributos.' });
      }
    }

    if (!dryRun) {
      await this.prisma.$transaction(async (tx) => {
        for (const item of toCreate) {
          const p = await tx.product.create({ data: item.data });
          if (p.trackStock && p.stock > 0) {
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
               }
             });
          }
          result.created++;
        }
        for (const item of toUpdate) {
          const p = await tx.product.update({ where: { id: item.id }, data: item.data });
          if (item.stockDiff !== 0) {
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
               }
             });
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
      const ind = await this.prisma.industry.findUnique({ where: { id: industryId }, include: { fieldTemplates: { orderBy: { order: 'asc' } } }});
      if (!ind) throw new BadRequestException('Industria no encontrada');
      targets = [...CORE_TARGETS, ...ind.fieldTemplates.map(f => ({
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
      else if (t.id === 'sku') sampleRow[t.id] = "'10001"; // Prefix with quote to avoid number format
      else if (t.id === 'barcode') sampleRow[t.id] = "'123456789012";
      else if (t.id === 'price') sampleRow[t.id] = 100.50;
      else if (t.id === 'cost') sampleRow[t.id] = 50.00;
      else if (t.id === 'trackStock' || t.id === 'taxIncluded' || t.id === 'isActive') sampleRow[t.id] = 'SI';
      else if (t.id === 'stock') sampleRow[t.id] = 10;
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
      wsHelp.addRow({ col: t.label, req: t.required ? 'Sí' : 'No', type: typeStr, desc: '...' });
    }

    return workbook;
  }

  async exportProducts(businessId: string): Promise<exceljs.Workbook> {
    const workbook = new exceljs.Workbook();
    const ws = workbook.addWorksheet('Productos');
    const targets = await this.getTargets(businessId);
    
    ws.columns = targets.map(t => ({ 
      header: t.label, 
      key: t.id, 
      width: 20,
      style: (t.id === 'sku' || t.id === 'barcode') ? { numFmt: '@' } : undefined
    }));

    const products = await this.prisma.product.findMany({
      where: { businessId },
      include: { category: true, supplier: true }
    });

    for (const p of products) {
      const row: any = {};
      const attrs = (typeof p.attributes === 'object' ? p.attributes : {}) as Record<string, any>;

      for (const t of targets) {
        if (t.kind === 'core') {
           if (t.id === 'categoryId') row[t.id] = p.category?.name || '';
           else if (t.id === 'supplierId') row[t.id] = p.supplier?.name || '';
           else if (t.id === 'sku' || t.id === 'barcode') row[t.id] = p[t.id] || '';
           else if (t.id === 'trackStock' || t.id === 'taxIncluded' || t.id === 'isActive') {
             row[t.id] = (p as any)[t.id] ? 'SI' : 'NO';
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
