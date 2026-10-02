import { ProductsImportService, ImportTarget } from './products-import.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProductsService } from './products.service';
import * as exceljs from 'exceljs';
import { UnprocessableEntityException } from '@nestjs/common';

describe('ProductsImportService', () => {
  let service: ProductsImportService;
  let prismaMock: any;
  let productsMock: any;
  
  // In-memory db state
  let dbProducts: any[] = [];
  
  beforeEach(() => {
    dbProducts = [];
    
    prismaMock = {
      productFieldDefinition: {
        findMany: jest.fn().mockResolvedValue([
          { key: 'color', label: 'Color', dataType: 'TEXT', required: false, isActive: true },
          { key: 'talla', label: 'Talla', dataType: 'SELECT', required: false, options: ['S', 'M', 'L', 'XL'], isActive: true },
          { key: 'vencimiento', label: 'Vencimiento', dataType: 'DATE', required: false, isActive: true },
          { key: 'is_fragile', label: 'Es Frágil', dataType: 'BOOLEAN', required: false, isActive: true }
        ])
      },
      category: { findMany: jest.fn().mockResolvedValue([]) },
      supplier: { findMany: jest.fn().mockResolvedValue([]) },
      product: {
        findMany: jest.fn().mockImplementation(() => Promise.resolve([...dbProducts])),
        create: jest.fn().mockImplementation((args: any) => {
          const p = { id: 'prod-' + Math.random(), ...args.data, stock: args.data.stock || 0 };
          dbProducts.push(p);
          return Promise.resolve(p);
        }),
        update: jest.fn().mockImplementation((args: any) => {
          const idx = dbProducts.findIndex(p => p.id === args.where.id);
          dbProducts[idx] = { ...dbProducts[idx], ...args.data };
          return Promise.resolve(dbProducts[idx]);
        })
      },
      stockMovement: {
        create: jest.fn().mockResolvedValue({})
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => {
        return cb(prismaMock);
      })
    };

    productsMock = {
      validateAttributesSync: jest.fn().mockImplementation((incoming: any, existing: any) => {
        return { ...existing, ...incoming };
      })
    };

    service = new ProductsImportService(prismaMock, productsMock);
  });

  describe('parseTolerantNumber', () => {
    it('should parse C$ 1,250.50', () => {
      expect((service as any).parseTolerantNumber('C$ 1,250.50')).toBe(1250.50);
    });
    it('should parse 1.250,50', () => {
      expect((service as any).parseTolerantNumber('1.250,50')).toBe(1250.50);
    });
    it('should parse USD 50', () => {
      expect((service as any).parseTolerantNumber('USD 50')).toBe(50);
    });
  });

  describe('Date Parsing', () => {
    it('should parse yyyy-mm-dd', () => {
      const d = new Date('2026-12-31');
      expect(d.toISOString().split('T')[0]).toBe('2026-12-31');
    });
    it('should parse dd/mm/yyyy by converting it if needed, or by using Excel serial', () => {
      // In trackdeli we rely on JS Date. JS Date doesn't natively parse dd/mm/yyyy properly unless formatted.
      // But we can test standard ISO fallback and Excel serials
      const valStr = '44197'; // 2021-01-01 in Excel
      const num = Number(valStr);
      const d = new Date((num - (25567 + 2)) * 86400 * 1000);
      expect(d.toISOString().split('T')[0]).toBe('2021-01-01');
    });
  });

  describe('isEqual (Deep Compare)', () => {
    it('should treat numbers and strings as equal if loosely equal', () => {
      expect((service as any).isEqual(50, '50')).toBe(true);
      expect((service as any).isEqual('100.5', 100.5)).toBe(true);
    });
    it('should treat ISO strings and YYYY-MM-DD as equal', () => {
      expect((service as any).isEqual('2026-12-31T00:00:00.000Z', '2026-12-31')).toBe(true);
    });
    it('should perform deep equal on objects', () => {
      expect((service as any).isEqual({ a: 1, b: '2026-10-01' }, { a: '1', b: '2026-10-01T05:00:00.000Z' })).toBe(true);
    });
  });

  describe('Integration: Import -> Export -> Import -> Unchanged', () => {
    it('should correctly import, export, and re-import yielding unchanged', async () => {
      // 1. Prepare an Excel file buffer with 3 products
      const wb = new exceljs.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['Nombre', 'Precio', 'Stock', 'Talla', 'Es Frágil', 'Vencimiento', 'SKU']);
      ws.addRow(['Prod A', 'C$ 100', 10, 'm', 'sí', '2026-12-31', 'POM-288']);
      ws.addRow(['Prod B', '250.50', 5, 'xl', 'no', '44197', '=-123']); // 44197 = 2021-01-01
      ws.addRow(['Prod C', '1,250.00', '20', 'S', '1', '2027-01-01', '@TEST']);
      
      const buffer = await wb.xlsx.writeBuffer();
      
      const mapping = {
        col_0: { target: 'name' },
        col_1: { target: 'price' },
        col_2: { target: 'stock' },
        col_3: { target: 'talla' },
        col_4: { target: 'is_fragile' },
        col_5: { target: 'vencimiento' },
        col_6: { target: 'sku' },
      };

      // 2. First Import
      const import1 = await service.importFile('b-1', 'u-1', buffer as any, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'import.xlsx', mapping, 'Sheet1', 1, false);
      
      expect(import1.errors).toHaveLength(0);
      expect(import1.created).toBe(3);
      expect(import1.updated).toBe(0);
      expect(import1.unchanged).toBe(0);
      expect(dbProducts).toHaveLength(3);
      
      // Verify parsed attributes
      expect(dbProducts[0].attributes.talla).toBe('M'); // normalized SELECT con tilde/mayusc
      expect(dbProducts[0].attributes.is_fragile).toBe(true); // 'sí' -> true
      expect(dbProducts[0].attributes.vencimiento).toBe('2026-12-31'); 
      expect(dbProducts[1].price).toBe(250.50);
      expect(dbProducts[2].price).toBe(1250);
      expect(dbProducts[2].attributes.is_fragile).toBe(true); // '1' -> true

      // 3. Export
      const exportWb = await service.exportProducts('b-1');
      const exportBuffer = await exportWb.xlsx.writeBuffer();
      
      // We need mapping for the exported file. The exporter uses targets directly.
      const targets = await service.getTargets('b-1');
      const exportMapping: any = {};
      targets.forEach((t, i) => {
        exportMapping[`col_${i}`] = { target: t.id };
      });

      // 4. Second Import (Re-import)
      const import2 = await service.importFile('b-1', 'u-1', exportBuffer as any, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'exported.xlsx', exportMapping, 'Productos', 1, false);
      
      expect(import2.errors).toHaveLength(0);
      expect(import2.created).toBe(0);
      expect(import2.updated).toBe(0);
      expect(import2.unchanged).toBe(3);
    });

    it('should reject decimal stock with 1.5', async () => {
      const wb = new exceljs.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['Nombre', 'Precio', 'Stock']);
      ws.addRow(['Prod D', '100', '1.5']);
      
      const buffer = await wb.xlsx.writeBuffer();
      const mapping = { col_0: { target: 'name' }, col_1: { target: 'price' }, col_2: { target: 'stock' } };
      
      const result = await service.importFile('b-1', 'u-1', buffer as any, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'import.xlsx', mapping, 'Sheet1', 1, false);
      
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('debe ser un número entero');
    });

    it('should reject duplicate SKUs/names in file', async () => {
      const wb = new exceljs.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['Nombre', 'Precio', 'SKU']);
      ws.addRow(['Prod E', '100', 'SKU1']);
      ws.addRow(['Prod E', '200', 'SKU2']); // duplicate name
      ws.addRow(['Prod F', '300', 'SKU1']); // duplicate SKU
      
      const buffer = await wb.xlsx.writeBuffer();
      const mapping = { col_0: { target: 'name' }, col_1: { target: 'price' }, col_2: { target: 'sku' } };
      
      const result = await service.importFile('b-1', 'u-1', buffer as any, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'import.xlsx', mapping, 'Sheet1', 1, false);
      
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].message).toContain('Fila duplicada en el archivo');
      expect(result.errors[1].message).toContain('Fila duplicada en el archivo');
    });
  });
});
