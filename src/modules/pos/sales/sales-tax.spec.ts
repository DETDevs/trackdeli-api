import { Test, TestingModule } from '@nestjs/testing';
import { SalesService } from './sales.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessProductsService } from '../../business-products/business-products.service';
import { BadRequestException } from '@nestjs/common';
import { PosPaymentMethod } from '@prisma/client';

describe('SalesService - Tax Calculation', () => {
  let service: SalesService;
  let prisma: PrismaService;

  const mockPrisma = {
    $transaction: jest.fn((callback) => callback(mockPrisma)),
    cashRegister: { findFirst: jest.fn() },
    business: { findUnique: jest.fn(), update: jest.fn() },
    product: { findFirst: jest.fn() },
    sale: { create: jest.fn() },
  };

  const mockBusinessProductsService = {
    isActive: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BusinessProductsService, useValue: mockBusinessProductsService },
      ],
    }).compile();

    service = module.get<SalesService>(SalesService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const baseDto = {
    cashRegisterId: 'reg-1',
    items: [
      { productName: 'Item A', unitPrice: 100, quantity: 2 }, // 200
      { productName: 'Item B', unitPrice: 50, quantity: 1, discount: 10 }, // 40
    ], // Subtotal: 240
    discountAmount: 20, // Final Subtotal: 220
    paymentMethod: PosPaymentMethod.EFECTIVO,
    amountPaid: 300,
  };

  beforeEach(() => {
    mockPrisma.cashRegister.findFirst.mockResolvedValue({ id: 'reg-1' });
    mockPrisma.sale.create.mockImplementation((args) => Promise.resolve({ id: 'sale-1', ...args.data }));
  });

  it('1. Impuesto deshabilitado', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ taxEnabled: false, taxIncluded: false, taxRate: 15 });
    
    await service.create(baseDto as any, 'biz-1', 'user-1');
    
    const createCall = mockPrisma.sale.create.mock.calls[0][0];
    expect(createCall.data.subtotal).toBe(240);
    expect(createCall.data.taxEnabled).toBe(false);
    expect(createCall.data.taxAmount).toBe(0);
    expect(createCall.data.total).toBe(220); // 240 - 20
  });

  it('2. Habilitado al 15%, precios sin impuesto', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ taxEnabled: true, taxIncluded: false, taxRate: 15 });
    
    await service.create(baseDto as any, 'biz-1', 'user-1');
    
    const createCall = mockPrisma.sale.create.mock.calls[0][0];
    expect(createCall.data.taxEnabled).toBe(true);
    expect(createCall.data.taxRate).toBe(15);
    expect(createCall.data.taxIncluded).toBe(false);
    // Final subtotal: 220
    // Tax = 220 * 0.15 = 33
    expect(createCall.data.taxAmount).toBe(33);
    expect(createCall.data.total).toBe(253); // 220 + 33
  });

  it('3. Habilitado al 15%, precios con impuesto incluido', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ taxEnabled: true, taxIncluded: true, taxRate: 15 });
    
    await service.create(baseDto as any, 'biz-1', 'user-1');
    
    const createCall = mockPrisma.sale.create.mock.calls[0][0];
    expect(createCall.data.taxEnabled).toBe(true);
    expect(createCall.data.taxIncluded).toBe(true);
    // Final subtotal: 220
    // Tax = 220 - (220 / 1.15) = 220 - 191.3043 = 28.70
    expect(createCall.data.taxAmount).toBeCloseTo(28.7, 2);
    expect(createCall.data.total).toBe(220); // Total no cambia
  });

  it('4. Snapshot del cliente offline es respetado (Cambio de tasa después)', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ taxEnabled: true, taxIncluded: false, taxRate: 0 }); // Negocio ahora es 0%
    
    const offlineDto = {
      ...baseDto,
      clientTaxEnabled: true,
      clientTaxIncluded: false,
      clientTaxRate: 15, // La venta se hizo al 15%
      clientTotal: 253, // Snapshot calculado correctamente por el cliente offline
      isOfflineSync: true,
      occurredAt: new Date().toISOString()
    };
    
    await service.create(offlineDto as any, 'biz-1', 'user-1');
    
    const createCall = mockPrisma.sale.create.mock.calls[0][0];
    expect(createCall.data.taxRate).toBe(0); // Fue recalculado con la vigente (0%)
    expect(createCall.data.taxAmount).toBe(0);
    expect(createCall.data.total).toBe(220); // Subtotal sin impuesto
    expect(createCall.data.notes).toContain('[AUDIT: Venta OFFLINE recalculada con impuesto vigente.');
    expect(createCall.data.notes).toContain('Diferencia en total. Cliente exigía: C$ 253. Servidor guardó: C$ 220.');
  });

  it('6. Total manipulado por el cliente es detectado y rechazado', async () => {
    mockPrisma.business.findUnique.mockResolvedValue({ taxEnabled: true, taxIncluded: false, taxRate: 15 });
    
    const hackedDto = {
      ...baseDto,
      clientTaxEnabled: true,
      clientTaxIncluded: false,
      clientTaxRate: 15,
      clientTotal: 100 // <--- Intento de hackeo, el real debería ser 253
    };
    
    await expect(service.create(hackedDto as any, 'biz-1', 'user-1'))
      .rejects
      .toThrow(BadRequestException);
  });
});
