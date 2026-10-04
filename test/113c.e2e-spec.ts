import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
const request = require('supertest');
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';

describe('113c - Doble moneda (córdoba y dólar)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let businessId: string;
  let encargadoId: string;
  let encargadoToken: string;
  let cajeroId: string;
  let cajeroToken: string;
  let cashRegisterId: string;
  let customerId: string;
  let productId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
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
    await prisma.posExchangeRate.deleteMany();
    await prisma.stockMovement.deleteMany();
    await prisma.product.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.membershipPaymentProduct.deleteMany();
    await prisma.membership.deleteMany();
    await prisma.user.deleteMany();
    await prisma.posPolicies.deleteMany();
    await prisma.businessProductSubscription.deleteMany();
    await prisma.business.deleteMany();

    // Setup Business
    const business = await prisma.business.create({
      data: { name: 'Test Business 113c', currency: 'NIO' },
    });
    businessId = business.id;

    // Activar POS
    const sub = await prisma.businessProductSubscription.create({
      data: {
        businessId,
        productType: 'POS',
        status: 'ACTIVE',
      },
    });

    const membership = await prisma.membership.create({
      data: {
        businessId,
        status: 'ACTIVE',
        startDate: new Date(Date.now() - 1000000),
        endDate: new Date(Date.now() + 1000000000),
        amount: 10,
        currency: 'USD',
        createdBy: 'system',
      },
    });

    await prisma.membershipPaymentProduct.create({
      data: {
        membershipPaymentId: membership.id,
        businessProductSubscriptionId: sub.id,
      },
    });

    // Setup Policies con multiCurrencyEnabled = true y acceptedCurrencies = NIO,USD
    await prisma.posPolicies.create({
      data: {
        businessId,
        blindCashClose: false,
        cashDifferenceTolerance: 0,
        paymentMethodsEnabled: 'EFECTIVO,TARJETA,TRANSFERENCIA,CREDITO',
        multiCurrencyEnabled: true,
        acceptedCurrencies: 'NIO,USD',
      },
    });

    // Users
    const passwordHash = await bcrypt.hash('password123', 10);
    const encargado = await prisma.user.create({
      data: { businessId, email: 'encargado@113c.com', passwordHash, role: 'ENCARGADO', name: 'Encargado 113c', isActive: true },
    });
    encargadoId = encargado.id;
    encargadoToken = jwtService.sign({ sub: encargadoId, email: encargado.email, role: 'ENCARGADO', businessId });

    const cajero = await prisma.user.create({
      data: { businessId, email: 'cajero@113c.com', passwordHash, role: 'CAJERO', name: 'Cajero 113c', isActive: true },
    });
    cajeroId = cajero.id;
    cajeroToken = jwtService.sign({ sub: cajeroId, email: cajero.email, role: 'CAJERO', businessId });

    // Product at C$ 218.50
    const prod = await prisma.product.create({
      data: { businessId, name: 'Prod 218.50', price: 218.50, stock: 1000 },
    });
    productId = prod.id;

    const cust = await prisma.customer.create({
      data: { businessId, name: 'Cliente Dólares', phone: '555-1234' },
    });
    customerId = cust.id;

    // Open cash register with 100 NIO
    const regRes = await request(app.getHttpServer())
      .post('/pos/cash-register/open')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({ openingCash: 100 });
    expect(regRes.status).toBe(201);
    cashRegisterId = regRes.body.id;
  });

  it('113c - Verificación integral de doble moneda, tasa vigente y recálculo', async () => {
    // 1. GET /pos/exchange-rate inicial devuelve 36.6243 (OFICIAL)
    const rateRes1 = await request(app.getHttpServer())
      .get('/pos/exchange-rate')
      .set('Authorization', `Bearer ${cajeroToken}`);
    expect(rateRes1.status).toBe(200);
    expect(rateRes1.body.rate).toBe(36.6243);
    expect(rateRes1.body.source).toBe('OFICIAL');
    expect(typeof rateRes1.body.rate).toBe('number');

    // 2. Venta 1: C$ 218.50 pagado con US$ 10 a tasa 36.6243
    // -> amountBase C$ 366.24, vuelto C$ 147.74 en córdobas
    const sale1Res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({
        cashRegisterId,
        customerId,
        items: [{ productId, productName: 'Prod 218.50', quantity: 1, unitPrice: 218.50 }],
        payments: [
          {
            method: 'EFECTIVO',
            currency: 'USD',
            amount: 10,
            amountTendered: 10,
          },
        ],
      });

    expect(sale1Res.status).toBe(201);
    expect(sale1Res.body.total).toBe(218.50);
    expect(sale1Res.body.change).toBe(147.74);
    expect(typeof sale1Res.body.change).toBe('number');

    const payment1 = sale1Res.body.payments[0];
    expect(payment1.currency).toBe('USD');
    expect(payment1.amountTendered).toBe(10);
    expect(payment1.exchangeRate).toBe(36.6243);
    expect(payment1.amountBase).toBe(366.24);
    expect(payment1.change).toBe(147.74);
    expect(typeof payment1.amountBase).toBe('number');
    expect(typeof payment1.exchangeRate).toBe('number');
    expect(typeof payment1.change).toBe('number');

    const sale1Id = sale1Res.body.id;

    // 3. Cambiar la tasa a 37.00 (PUT /pos/exchange-rate por ENCARGADO)
    const updateRateRes = await request(app.getHttpServer())
      .put('/pos/exchange-rate')
      .set('Authorization', `Bearer ${encargadoToken}`)
      .send({ rate: 37.00 });
    expect(updateRateRes.status).toBe(200);
    expect(updateRateRes.body.rate).toBe(37);
    expect(updateRateRes.body.source).toBe('MANUAL');
    expect(typeof updateRateRes.body.rate).toBe('number');

    // 4. Venta 2: C$ 218.50 pagado con US$ 10 a nueva tasa 37.00
    // -> amountBase C$ 370.00, vuelto C$ 151.50 en córdobas
    const sale2Res = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({
        cashRegisterId,
        customerId,
        items: [{ productId, productName: 'Prod 218.50', quantity: 1, unitPrice: 218.50 }],
        payments: [
          {
            method: 'EFECTIVO',
            currency: 'USD',
            amount: 10,
            amountTendered: 10,
          },
        ],
      });

    expect(sale2Res.status).toBe(201);
    expect(sale2Res.body.total).toBe(218.50);
    expect(sale2Res.body.change).toBe(151.50);

    const payment2 = sale2Res.body.payments[0];
    expect(payment2.currency).toBe('USD');
    expect(payment2.amountTendered).toBe(10);
    expect(payment2.exchangeRate).toBe(37);
    expect(payment2.amountBase).toBe(370);
    expect(payment2.change).toBe(151.50);

    // 5. La venta anterior conserva su tasa 36.6243 y su amountBase 366.24
    const getSale1Res = await request(app.getHttpServer())
      .get(`/pos/sales/${sale1Id}`)
      .set('Authorization', `Bearer ${cajeroToken}`);
    expect(getSale1Res.status).toBe(200);
    expect(getSale1Res.body.payments[0].exchangeRate).toBe(36.6243);
    expect(getSale1Res.body.payments[0].amountBase).toBe(366.24);
    expect(getSale1Res.body.payments[0].change).toBe(147.74);

    // 6. Con multiCurrencyEnabled=false el USD se rechaza con 400
    const updatePoliciesRes = await request(app.getHttpServer())
      .patch('/pos/policies')
      .set('Authorization', `Bearer ${encargadoToken}`)
      .send({ multiCurrencyEnabled: false });
    expect(updatePoliciesRes.status).toBe(200);

    const rejectedSaleRes = await request(app.getHttpServer())
      .post('/pos/sales')
      .set('Authorization', `Bearer ${cajeroToken}`)
      .send({
        cashRegisterId,
        customerId,
        items: [{ productId, productName: 'Prod 218.50', quantity: 1, unitPrice: 218.50 }],
        payments: [
          {
            method: 'EFECTIVO',
            currency: 'USD',
            amount: 10,
            amountTendered: 10,
          },
        ],
      });
    expect(rejectedSaleRes.status).toBe(400);
    expect(rejectedSaleRes.body.code).toBe('CURRENCY_NOT_ALLOWED');
  });
});
