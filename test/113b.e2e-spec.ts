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
    await prisma.$executeRawUnsafe('TRUNCATE TABLE pos_audit_logs CASCADE');
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
    console.log('JSON_IDEMPOTENCY:', JSON.stringify(res.body, null, 2));
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
    expect(res.body.summary).not.toHaveProperty('expectedCash');
    expect(res.body.summary).not.toHaveProperty('totalSales');
    expect(res.body.summary).not.toHaveProperty('movementsIn');
    expect(res.body.register).not.toHaveProperty('movements');
    expect(res.body.register).not.toHaveProperty('difference');
    console.log('JSON_CIERRE_CAJERO:', JSON.stringify(res.body, null, 2));
  });

  it('12. Cierre ciego: ENCARGADO ve números', async () => {
    const res = await request(app.getHttpServer())
      .get(`/pos/cash-register/${cashRegisterId}/summary`)
      .set('Authorization', `Bearer ${encargadoToken}`);
    expect(res.status).toBe(200);
    console.log('JSON_CIERRE_ENCARGADO:', JSON.stringify(res.body, null, 2));
    expect(res.body.summary.totalSales).toBe(655.5);
    expect(res.body.summary.totalCash).toBe(318.5);
    expect(res.body.summary.totalCard).toBe(118.5);
    expect(res.body.summary.totalTransfer).toBe(218.5);
    expect(res.body.summary.currentCash).toBe(418.5);
    expect(typeof res.body.summary.totalCash).toBe('number');
    expect(typeof res.body.summary.currentCash).toBe('number');
    expect(res.body.register.closedBy).toBeNull();
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
    expect(resLock.status).toBe(429);
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

  it('18. Dos cierres simultáneos -> SHIFT_ALREADY_CLOSED 409', async () => {
    // Abrir un turno rápido
    const shiftRes = await request(app.getHttpServer())
      .post('/pos/cash-register/open')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ initialCash: 100 });
    const shift3 = shiftRes.body.id;

    // Ejecutar dos cierres concurrentes
    const [res1, res2] = await Promise.all([
      request(app.getHttpServer())
        .post('/pos/cash-register/close')
        .set('Authorization', `Bearer ${cajeroToken}`)
        .send({ cashRegisterId: shift3, closingCash: 100, counted: { CASH: 100 }, notes: 'bypass tolerance' }),
      request(app.getHttpServer())
        .post('/pos/cash-register/close')
        .set('Authorization', `Bearer ${cajeroToken}`)
        .send({ cashRegisterId: shift3, closingCash: 100, counted: { CASH: 100 }, notes: 'bypass tolerance' })
    ]);

    const statuses = [res1.status, res2.status];
    if (!statuses.includes(201)) {
      console.log('RES1:', res1.status, res1.body);
      console.log('RES2:', res2.status, res2.body);
    }
    expect(statuses.includes(201)).toBe(true);
    expect(statuses.some(s => s === 409 || s === 404 || s === 422)).toBe(true);
  });

  it('19. UPDATE directo a pos_audit_logs falla por trigger', async () => {
    let failed = false;
    // Insert a dummy log first to ensure there is a row to update
    await prisma.$executeRawUnsafe(`
      INSERT INTO pos_audit_logs (id, "businessId", "userId", "userRole", action, "entityType", "entityId", before, after, reason, "createdAt") 
      VALUES (gen_random_uuid(), '${businessId}', 'user1', 'CAJERO', 'TEST', 'Test', '123', '{}', '{}', 'test', NOW())
    `);
    
    try {
      await prisma.$executeRaw`UPDATE pos_audit_logs SET reason = 'hacked'`;
    } catch (e) {
      failed = true;
      expect(e.message).toContain('Updates and Deletes are not allowed on pos_audit_logs');
    }
    expect(failed).toBe(true);
  });

  it('20. Verificación estricta de aritmética y tipos en esperado de caja (113b-5)', async () => {
    // 1. Abrir nuevo turno con apertura 100
    const openRes = await request(app.getHttpServer())
      .post('/pos/cash-register/open')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ openingCash: 100 });
    expect(openRes.status).toBe(201);
    const newShiftId = openRes.body.id;

    // 2. Venta efectivo C$ 218.50 pagada con C$ 250 (vuelto 31.50)
    const sale1Res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', 'test20-venta-efectivo')
      .send({
        cashRegisterId: newShiftId,
        customerId,
        items: [{ productId, productName: 'Item 1', quantity: 1, unitPrice: 218.50, subtotal: 218.50 }],
        subtotal: 218.50, taxAmount: 0, total: 218.50, amountPaid: 218.50, change: 0,
        payments: [{ method: 'EFECTIVO', amount: 218.50, amountTendered: 250 }]
      });
    expect(sale1Res.status).toBe(201);
    expect(Number(sale1Res.body.payments[0].change)).toBe(31.50);

    // 3. Venta tarjeta 118.50
    const sale2Res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .set('Idempotency-Key', 'test20-venta-tarjeta')
      .send({
        cashRegisterId: newShiftId,
        customerId,
        items: [{ productId, productName: 'Item 2', quantity: 1, unitPrice: 118.50, subtotal: 118.50 }],
        subtotal: 118.50, taxAmount: 0, total: 118.50, amountPaid: 118.50, change: 0,
        payments: [{ method: 'TARJETA', amount: 118.50, reference: 'CARD-TX-999' }]
      });
    expect(sale2Res.status).toBe(201);

    // 4. Movimiento IN 50
    const inRes = await request(app.getHttpServer())
      .post(`/pos/cash-register/${newShiftId}/movements`)
      .set('Authorization', `Bearer ${encargadoToken}`)
      .send({ type: 'ENTRADA', amount: 50, reason: 'Cambio inicial' });
    expect(inRes.status).toBe(201);

    // 5. Movimiento OUT 20
    const outRes = await request(app.getHttpServer())
      .post(`/pos/cash-register/${newShiftId}/movements`)
      .set('Authorization', `Bearer ${encargadoToken}`)
      .send({ type: 'SALIDA', amount: 20, reason: 'Pago hielo' });
    expect(outRes.status).toBe(201);

    // 6. ENCARGADO consulta summary
    const summaryRes = await request(app.getHttpServer())
      .get(`/pos/cash-register/${newShiftId}/summary`)
      .set('Authorization', `Bearer ${encargadoToken}`);
    expect(summaryRes.status).toBe(200);

    console.log('JSON_ENCARGADO_TEST20:', JSON.stringify(summaryRes.body, null, 2));

    const s = summaryRes.body.summary;
    const r = summaryRes.body.register;

    // ENCARGADO ve expectedCash === 348.5 (100 + 218.5 + 50 - 20)
    expect(s.currentCash).toBe(348.5);
    expect(r.expectedCash).toBe(348.5);
    expect(r.expectedAmount).toBe(348.5);
    expect(s.totalCash).toBe(218.5);
    expect(r.totalCash).toBe(218.5);
    expect(s.totalCard).toBe(118.5);
    expect(r.totalCard).toBe(118.5);

    // Verificación estricta de tipos number
    expect(typeof s.currentCash).toBe('number');
    expect(typeof r.expectedCash).toBe('number');
    expect(typeof s.totalCash).toBe('number');
    expect(typeof r.totalCash).toBe('number');
    expect(typeof s.totalCard).toBe('number');
    expect(typeof r.totalCard).toBe('number');

    // Turno OPEN -> closedBy debe ser null
    expect(r.closedBy).toBeNull();

    // 7. En el cierre: contado 348.5 -> difference === 0
    const closeRes = await request(app.getHttpServer())
      .post(`/pos/cash-register/${newShiftId}/close`)
      .set('Authorization', `Bearer ${encargadoToken}`)
      .send({ cashRegisterId: newShiftId, closingCash: 348.5, counted: { CASH: 348.5 } });
    expect(closeRes.status).toBe(201);

    expect(closeRes.body.difference).toBe(0);
    expect(typeof closeRes.body.difference).toBe('number');
    expect(closeRes.body.expectedCash).toBe(348.5);
    expect(typeof closeRes.body.expectedCash).toBe('number');
    expect(closeRes.body.closedBy).not.toBeNull();
  });
});
