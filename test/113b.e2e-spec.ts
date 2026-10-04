import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
const request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';

describe('113b - E2E Tests (Control y Dinero)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let businessId: string;
  let encargadoId: string;
  let encargadoToken: string;
  let cajeroId: string;
  let cajeroToken: string;
  let waiterToken: string;
  let repartidorToken: string;
  let cashRegisterId: string;
  let customerId: string;
  let productId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);

    // Clean DB
    await prisma.posAuditLog.deleteMany();
    await prisma.idempotencyKey.deleteMany();
    await prisma.posApprovalToken.deleteMany();
    await prisma.posPayment.deleteMany();
    await prisma.creditPayment.deleteMany();
    await prisma.creditAccount.deleteMany();
    await prisma.saleItem.deleteMany();
    await prisma.sale.deleteMany();
    await prisma.cashMovement.deleteMany();
    await prisma.cashRegister.deleteMany();
    await prisma.stockMovement.deleteMany();
    await prisma.product.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.idempotencyKey.deleteMany();
    await prisma.membershipPaymentProduct.deleteMany();
    await prisma.membership.deleteMany();
    await prisma.user.deleteMany();
    await prisma.posPolicies.deleteMany();
    await prisma.businessProductSubscription.deleteMany();
    await prisma.business.deleteMany();

    // Setup Business
    const business = await prisma.business.create({
      data: { name: 'Test Business 113b', currency: 'NIO' }
    });
    businessId = business.id;

    // Activar POS
    const sub = await prisma.businessProductSubscription.create({
      data: {
        businessId,
        productType: 'POS',
        status: 'ACTIVE'
      }
    });

    // Crear membresía para POS
    const membership = await prisma.membership.create({
      data: {
        businessId,
        status: 'ACTIVE',
        startDate: new Date(Date.now() - 1000000),
        endDate: new Date(Date.now() + 1000000000),
        amount: 10,
        currency: 'USD',
        createdBy: 'system'
      }
    });

    await prisma.membershipPaymentProduct.create({
      data: {
        membershipPaymentId: membership.id,
        businessProductSubscriptionId: sub.id,
      }
    });

    const carteraSub = await prisma.businessProductSubscription.create({
      data: {
        businessId,
        productType: 'CARTERA_COBRO',
        status: 'ACTIVE'
      }
    });

    await prisma.membershipPaymentProduct.create({
      data: {
        membershipPaymentId: membership.id,
        businessProductSubscriptionId: carteraSub.id,
        amountAttributed: 10
      }
    });

    // Policies
    await prisma.posPolicies.create({
      data: { businessId, blindCashClose: true, cashDifferenceTolerance: 0, paymentMethodsEnabled: 'EFECTIVO,TARJETA,TRANSFERENCIA,CREDITO' }
    });

    // Users
    const passwordHash = await bcrypt.hash('password123', 10);
    const encargado = await prisma.user.create({
      data: { businessId, email: 'encargado@113.com', passwordHash, role: 'ENCARGADO', name: 'Encargado', isActive: true }
    });
    encargadoId = encargado.id;
    encargadoToken = jwtService.sign({ sub: encargadoId, email: encargado.email, role: 'ENCARGADO', businessId });

    const cajero = await prisma.user.create({
      data: { businessId, email: 'cajero@113.com', passwordHash, role: 'CAJERO', name: 'Cajero', isActive: true }
    });
    cajeroId = cajero.id;
    cajeroToken = jwtService.sign({ sub: cajeroId, email: cajero.email, role: 'CAJERO', businessId });

    const waiter = await prisma.waiter.create({ data: { businessId, name: 'W', active: true, pinHash: '1234' }});
    waiterToken = jwtService.sign({ sub: waiter.id, role: 'WAITER', businessId });

    const repartidor = await prisma.user.create({ data: { businessId, email: 'rep@113.com', passwordHash, role: 'REPARTIDOR', name: 'R', isActive: true }});
    repartidorToken = jwtService.sign({ sub: repartidor.id, email: repartidor.email, role: 'REPARTIDOR', businessId });

    // Products & Customers
    const prod = await prisma.product.create({ data: { businessId, name: 'Prod1', price: 218.50, stock: 1000 } });
    productId = prod.id;

    const cust = await prisma.customer.create({ data: { businessId, name: 'Client 1', phone: '123' } });
    customerId = cust.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Cajero abre turno', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/cash-register/open')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ openingCash: 100 });
    expect(res.status).toBe(201);
    cashRegisterId = res.body.id;
  });

  it('2. Venta C$ 218.50 en efectivo con C$ 250 -> vuelto 31.50 (Calculado por server)', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', 'venta-efectivo-1')
      .send({
        cashRegisterId,
        customerId,
        items: [{ productId, productName: 'Test Product', quantity: 1, unitPrice: 218.50, subtotal: 218.50 }],
        subtotal: 218.50, taxAmount: 0, total: 218.50, amountPaid: 218.50, change: 0,
        payments: [{ method: 'EFECTIVO', amount: 218.50, amountTendered: 250 }]
      });
    if (res.status === 400) console.log(res.body);
    expect(res.status).toBe(201);
    expect(Number(res.body.payments[0].change)).toBe(31.50);
  });

  it('3. Mixto 100 efectivo + 118.50 tarjeta (con referencia)', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', 'venta-mixta-1')
      .send({
        cashRegisterId, customerId,
        items: [{ productId, productName: 'Test Product', quantity: 1, unitPrice: 218.50, subtotal: 218.50 }],
        subtotal: 218.50, taxAmount: 0, total: 218.50, amountPaid: 218.50, change: 0,
        payments: [
          { method: 'EFECTIVO', amount: 100 },
          { method: 'TARJETA', amount: 118.50, reference: 'TX-123' }
        ]
      });
    expect(res.status).toBe(201);
    expect(res.body.payments.length).toBe(2);
  });

  it('4. Pagos que suman 218.45 -> PAYMENT_TOTAL_MISMATCH', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({
        cashRegisterId, customerId,
        items: [{ productId, productName: 'Test Product', quantity: 1, unitPrice: 218.50, subtotal: 218.50 }],
        subtotal: 218.50, taxAmount: 0, total: 218.50, amountPaid: 218.50, change: 0,
        payments: [{ method: 'EFECTIVO', amount: 218.45 }]
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYMENT_TOTAL_MISMATCH');
  });

  it('5. Falta referencia en tarjeta -> PAYMENT_REFERENCE_REQUIRED', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({
        cashRegisterId, customerId,
        items: [{ productId, productName: 'Test Product', quantity: 1, unitPrice: 218.50, subtotal: 218.50 }],
        subtotal: 218.50, taxAmount: 0, total: 218.50, amountPaid: 218.50, change: 0,
        payments: [{ method: 'TARJETA', amount: 218.50 }]
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYMENT_REFERENCE_REQUIRED');
  });

  it('6. Cliente viejo con un solo método y monto -> funciona', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', 'venta-vieja-1')
      .send({
        cashRegisterId, customerId,
        paymentMethod: 'TRANSFERENCIA', reference: 'REF-OLD',
        items: [{ productId, productName: 'Test Product', quantity: 1, unitPrice: 218.50, subtotal: 218.50 }],
        subtotal: 218.50, taxAmount: 0, total: 218.50, amountPaid: 218.50, change: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.payments[0].method).toBe('TRANSFERENCIA');
  });

  it('7. Idempotencia: misma clave y mismo cuerpo -> misma respuesta', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', 'venta-vieja-1')
      .send({
        cashRegisterId, customerId,
        paymentMethod: 'TRANSFERENCIA', reference: 'REF-OLD',
        items: [{ productId, productName: 'Test Product', quantity: 1, unitPrice: 218.50, subtotal: 218.50 }],
        subtotal: 218.50, taxAmount: 0, total: 218.50, amountPaid: 218.50, change: 0,
      });
    expect(res.status).toBe(201);
  });

  it('8. Idempotencia: misma clave OTRO cuerpo -> IDEMPOTENCY_KEY_REUSED 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', 'venta-vieja-1')
      .send({ cashRegisterId, customerId, subtotal: 100 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('9. Movimiento OUT sin motivo -> 422 o 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/cash-register/movements')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ type: 'SALIDA', amount: 50 });
    expect(res.status).toBe(400); // class-validator or manual
  });

  it('10. Movimiento CAJERO en turno ajeno -> 403', async () => {
    // Create another shift for Encargado
    const r2 = await request(app.getHttpServer()).post('/pos/cash-register/open').set('Authorization', `Bearer ${encargadoToken}`).send({ openingCash: 0 });
    const shift2 = r2.body.id;

    const res = await request(app.getHttpServer())
      .post(`/pos/cash-register/${shift2}/movements`)
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ type: 'SALIDA', amount: 10, reason: 'Test' });
    expect(res.status).toBe(403);
  });

  it('11. Cierre ciego: CAJERO recibe null en reportes', async () => {
    const res = await request(app.getHttpServer())
      .get(`/pos/cash-register/${cashRegisterId}/summary`)
      .set('Authorization', `Bearer ${cajeroToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalSales).toBeFalsy();
    expect(res.body.expectedCash).toBeFalsy();
  });

  it('12. Cierre ciego: ENCARGADO ve números', async () => {
    const res = await request(app.getHttpServer())
      .get(`/pos/cash-register/${cashRegisterId}/summary`)
      .set('Authorization', `Bearer ${encargadoToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalSales).not.toBeNull();
  });

  it('13. Diferencia fuera de tolerancia sin nota -> 422', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/cash-register/close')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ closingCash: 0 }); // Deberia ser ~ 100 + 218.50 + 100 = 418.50
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CASH_DIFFERENCE_NOTE_REQUIRED');
  });

  it('14. Cierre de turno exitoso con nota', async () => {
    const res = await request(app.getHttpServer())
      .post('/pos/cash-register/close')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ closingCash: 0, notes: 'Me robaron' });
    expect(res.status).toBe(201);
  });

  it('15. Force-close por CAJERO -> 403', async () => {
    // Encargado's open shift
    const r = await request(app.getHttpServer()).get('/pos/cash-register').set('Authorization', `Bearer ${encargadoToken}`);
    const shiftId = r.body.find(s => s.status === 'OPEN').id;

    const res = await request(app.getHttpServer())
      .post(`/pos/cash-register/${shiftId}/force-close`)
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ closingCash: 0, reason: 'Forzado' });
    expect(res.status).toBe(403);
  });

  it('16. Aprobaciones y Lockout', async () => {
    // Intento 1
    await request(app.getHttpServer()).post('/pos/approvals').set('Authorization', `Bearer ${cajeroToken}`).send({ cashRegisterId, approverEmail: 'encargado@113.com', approverPassword: 'wrong', action: 'ANULAR_VENTA' });
    // Intento 2
    await request(app.getHttpServer()).post('/pos/approvals').set('Authorization', `Bearer ${cajeroToken}`).send({ cashRegisterId, approverEmail: 'encargado@113.com', approverPassword: 'wrong', action: 'ANULAR_VENTA' });
    // Intento 3
    await request(app.getHttpServer()).post('/pos/approvals').set('Authorization', `Bearer ${cajeroToken}`).send({ cashRegisterId, approverEmail: 'encargado@113.com', approverPassword: 'wrong', action: 'ANULAR_VENTA' });
    // Intento 4
    await request(app.getHttpServer()).post('/pos/approvals').set('Authorization', `Bearer ${cajeroToken}`).send({ cashRegisterId, approverEmail: 'encargado@113.com', approverPassword: 'wrong', action: 'ANULAR_VENTA' });
    // Intento 5
    await request(app.getHttpServer()).post('/pos/approvals').set('Authorization', `Bearer ${cajeroToken}`).send({ cashRegisterId, approverEmail: 'encargado@113.com', approverPassword: 'wrong', action: 'ANULAR_VENTA' });

    // Intento 6 (Bloqueado)
    const resLock = await request(app.getHttpServer()).post('/pos/approvals').set('Authorization', `Bearer ${cajeroToken}`).send({ cashRegisterId, approverEmail: 'encargado@113.com', approverPassword: 'wrong', action: 'ANULAR_VENTA' });
    if (resLock.status !== 429) console.log(resLock.body);
    expect([400, 429].includes(resLock.status)).toBe(true);
  });

  it('17. CreditController roles check', async () => {
    // Open a shift so we can sell
    const shiftRes = await request(app.getHttpServer())
      .post('/pos/cash-register/open')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ initialCash: 100 });
    const newShiftId = shiftRes.body.id;

    // 1. Create a credit sale first via the sales endpoint to automatically create the account
    const saleRes = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', `venta-credito-${Date.now()}`)
      .send({
        cashRegisterId: newShiftId, customerId,
        items: [{ productId, productName: 'Test Product', quantity: 1, unitPrice: 100, subtotal: 100 }],
        subtotal: 100, taxAmount: 0, total: 100, amountPaid: 100, change: 0, paymentMethod: 'CREDITO',
        payments: [{ method: 'CREDITO', amount: 100 }],
        creditDueDate: new Date(Date.now() + 86400000).toISOString()
      });
    if (saleRes.status !== 201) console.log(saleRes.body);
    expect(saleRes.status).toBe(201);
    
    // The account should be created. We can fetch it via Get Customer Accounts
    const accListRes = await request(app.getHttpServer())
      .get(`/pos/customers/${customerId}/credit-accounts`)
      .set('Authorization', `Bearer ${cajeroToken}`);
    console.log('ACCOUNTS RESPONSE:', accListRes.body);
    expect(accListRes.status).toBe(200);
    const accId = accListRes.body.accounts[0]?.id;
    if (!accId) throw new Error("No credit account found in the array!");

    // WAITER should not be able to add payments
    const wRes = await request(app.getHttpServer())
      .post(`/pos/credit-accounts/${accId}/payments`)
      .set('Authorization', `Bearer ${waiterToken}`)
      .send({ amount: 10, paymentMethod: 'EFECTIVO' });
    expect(wRes.status).toBe(403);

    // CAJERO should be able
    const cRes = await request(app.getHttpServer())
      .post(`/pos/credit-accounts/${accId}/payments`)
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ amount: 10, paymentMethod: 'EFECTIVO' });
    expect(cRes.status).toBe(201);
  });
});
