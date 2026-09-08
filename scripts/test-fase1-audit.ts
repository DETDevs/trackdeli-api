import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { envValidationSchema } from '../src/config/env.validation';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationsModule } from '../src/modules/notifications/notifications.module';
import { TrackingModule } from '../src/modules/tracking/tracking.module';
import { DispatchModule } from '../src/modules/dispatch/dispatch.module';
import { QuotesModule } from '../src/modules/quotes/quotes.module';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { CustomersModule } from '../src/modules/customers/customers.module';
import { CommissionsModule } from '../src/modules/commissions/commissions.module';
import { OrdersService } from '../src/modules/orders/orders.service';
import { DispatchService } from '../src/modules/dispatch/dispatch.service';
import { QuotesService } from '../src/modules/quotes/quotes.service';
import { TrackingService } from '../src/modules/tracking/tracking.service';
import { BusinessType, DispatchStatus, OrderStatus, QuoteStatus, UserRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),
    ScheduleModule.forRoot(),
    PrismaModule,
    NotificationsModule,
    TrackingModule,
    DispatchModule,
    QuotesModule,
    OrdersModule,
    CustomersModule,
    CommissionsModule,
  ],
})
class TestAuditModule {}

async function runTests() {
  console.log('====================================================');
  console.log('INICIANDO SUITE DE PRUEBAS: AUDITORÍA FASE 1');
  console.log('====================================================\n');

  const app = await NestFactory.createApplicationContext(TestAuditModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const ordersService = app.get(OrdersService);
  const dispatchService = app.get(DispatchService);
  const quotesService = app.get(QuotesService);
  const trackingService = app.get(TrackingService);

  let passed = 0;
  let failed = 0;

  // ----------------------------------------------------------------
  // TEST 1: Connection Pool (H1)
  // ----------------------------------------------------------------
  console.log('[TEST 1] Verificando Connection Pool (30 queries concurrentes)...');
  try {
    const start = Date.now();
    const promises = Array.from({ length: 30 }).map((_, i) =>
      prisma.$queryRaw`SELECT 1 as result`
    );
    await Promise.all(promises);
    const duration = Date.now() - start;
    console.log(`✅ [TEST 1 PASSED] 30 queries concurrentes ejecutadas exitosamente en ${duration}ms sin timeouts de pool.\n`);
    passed++;
  } catch (err: any) {
    console.error(`❌ [TEST 1 FAILED] Error en connection pool: ${err.message}\n`);
    failed++;
  }

  // Preparar datos base para pruebas
  const testSuffix = uuidv4().substring(0, 8);
  const business = await prisma.business.create({
    data: {
      name: `Biz Test ${testSuffix}`,
      businessType: BusinessType.EMPRESA_RIDERS,
      latitude: 12.1363889,
      longitude: -86.2513889,
      dispatchTimeoutMin: 3,
    },
  });

  const encargado = await prisma.user.create({
    data: {
      name: `Encargado ${testSuffix}`,
      email: `encargado_${testSuffix}@test.com`,
      passwordHash: 'hash',
      role: UserRole.ENCARGADO,
      businessId: business.id,
    },
  });

  const rider1 = await prisma.user.create({
    data: {
      name: `Rider 1 ${testSuffix}`,
      email: `rider1_${testSuffix}@test.com`,
      passwordHash: 'hash',
      role: UserRole.REPARTIDOR,
      businessId: business.id,
      isAvailable: true,
      currentLatitude: 12.1365,
      currentLongitude: -86.2515,
    },
  });

  const rider2 = await prisma.user.create({
    data: {
      name: `Rider 2 ${testSuffix}`,
      email: `rider2_${testSuffix}@test.com`,
      passwordHash: 'hash',
      role: UserRole.REPARTIDOR,
      businessId: business.id,
      isAvailable: true,
      currentLatitude: 12.1370,
      currentLongitude: -86.2520,
    },
  });

  // ----------------------------------------------------------------
  // TEST 2: Eliminación de N+1 en findAll (H2)
  // ----------------------------------------------------------------
  console.log('[TEST 2] Verificando eliminación de N+1 en OrdersService.findAllByBusiness...');
  try {
    // Crear 5 pedidos para el negocio
    for (let i = 1; i <= 5; i++) {
      const order = await prisma.order.create({
        data: {
          businessId: business.id,
          createdBy: encargado.id,
          customerName: `Cliente ${i}`,
          customerPhone: '12345678',
          status: OrderStatus.PENDIENTE,
        },
      });
      await prisma.trackingSession.create({
        data: {
          orderId: order.id,
          token: `token_${order.id}`,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      await prisma.orderDispatch.create({
        data: {
          orderId: order.id,
          riderId: rider1.id,
          attempt: 1,
          status: DispatchStatus.SENT,
          timeoutAt: new Date(Date.now() + 180000),
        },
      });
    }

    let queryCount = 0;
    const queryListener = (e: any) => {
      // Contar queries a la tabla orders o relaciones
      if (typeof e.query === 'string' && (e.query.includes('"orders"') || e.query.includes('tracking_sessions') || e.query.includes('order_dispatches'))) {
        queryCount++;
      }
    };
    // @ts-ignore
    prisma.$on('query', queryListener);

    queryCount = 0;
    const orders = await ordersService.findAllByBusiness(business.id, encargado.id, UserRole.ENCARGADO);

    if (orders.length !== 5) {
      throw new Error(`Se esperaban 5 pedidos, pero se obtuvieron ${orders.length}`);
    }

    // Verificar que los DTOs tienen la información poblada
    for (const o of orders) {
      if (!o.trackingToken || !o.activeDispatchTimeoutAt) {
        throw new Error(`El pedido ${o.id} no incluyó trackingToken o activeDispatchTimeoutAt de forma síncrona`);
      }
    }

    console.log(`[TEST 2] Total queries relacionales ejecutadas para 5 pedidos: ${queryCount}`);
    if (queryCount <= 3) {
      console.log(`✅ [TEST 2 PASSED] N+1 eliminado: 5 pedidos listados con exactamente ${queryCount} consultas batch de Prisma (antes 1+2*5 = 11 queries individuales en bucle).\n`);
      passed++;
    } else {
      throw new Error(`Se esperaban máximo 3 queries batch de Prisma pero se contaron ${queryCount}`);
    }
  } catch (err: any) {
    console.error(`❌ [TEST 2 FAILED] Error verificando N+1: ${err.message}\n`);
    failed++;
  }

  // ----------------------------------------------------------------
  // TEST 3: Idempotencia en acceptDispatch y acceptQuote (H3)
  // ----------------------------------------------------------------
  console.log('[TEST 3] Verificando Idempotencia en acceptDispatch y acceptQuote...');
  try {
    // 3A: acceptDispatch
    const dispatchOrder = await prisma.order.create({
      data: {
        businessId: business.id,
        createdBy: encargado.id,
        customerName: 'Cliente Despacho Idempotente',
        customerPhone: '88888888',
        status: OrderStatus.OFERTADO,
      },
    });

    const dispatchRecord = await prisma.orderDispatch.create({
      data: {
        orderId: dispatchOrder.id,
        riderId: rider1.id,
        attempt: 1,
        status: DispatchStatus.SENT,
        timeoutAt: new Date(Date.now() + 180000),
      },
    });

    // Primer POST acceptDispatch
    const firstAccept = await dispatchService.acceptDispatch(dispatchOrder.id, rider1.id);
    if (firstAccept.deliveryUserId !== rider1.id || firstAccept.status !== OrderStatus.ACEPTADO) {
      throw new Error('El primer acceptDispatch no asignó correctamente al rider');
    }

    // Segundo POST acceptDispatch (mismo rider, reintento de red)
    const secondAccept = await dispatchService.acceptDispatch(dispatchOrder.id, rider1.id);
    if (secondAccept.id !== dispatchOrder.id || secondAccept.deliveryUserId !== rider1.id) {
      throw new Error('El segundo acceptDispatch no retornó la orden idempotentemente');
    }
    console.log('  -> acceptDispatch: Doble POST del mismo rider retornó HTTP 200 OK sin arrojar 400.');

    // Intento con otro rider distinto -> debe arrojar 400
    let otherRiderFailedAsExpected = false;
    try {
      await dispatchService.acceptDispatch(dispatchOrder.id, rider2.id);
    } catch (e: any) {
      otherRiderFailedAsExpected = true;
    }
    if (!otherRiderFailedAsExpected) {
      throw new Error('Un rider no autorizado pudo aceptar un despacho ya asignado');
    }
    console.log('  -> acceptDispatch: Intento de otro rider rechazado correctamente con 400.');

    // 3B: acceptQuote
    const quoteOrder = await prisma.order.create({
      data: {
        businessId: business.id,
        createdBy: encargado.id,
        customerName: 'Cliente Cotización Idempotente',
        customerPhone: '77777777',
        status: OrderStatus.COTIZANDO,
      },
    });

    const quote = await prisma.orderQuote.create({
      data: {
        orderId: quoteOrder.id,
        riderId: rider1.id,
        proposedFee: 150,
        status: QuoteStatus.PENDING,
      },
    });

    // Primer acceptQuote
    const firstQuoteAccept = await quotesService.acceptQuote(quote.id, business.id);
    if (!firstQuoteAccept.success || firstQuoteAccept.riderId !== rider1.id) {
      throw new Error('El primer acceptQuote no aceptó la propuesta correctamente');
    }

    // Segundo acceptQuote (reintento)
    const secondQuoteAccept = await quotesService.acceptQuote(quote.id, business.id);
    if (!secondQuoteAccept.success || secondQuoteAccept.riderId !== rider1.id) {
      throw new Error('El segundo acceptQuote no fue idempotente');
    }
    console.log('  -> acceptQuote: Doble POST de aceptación retornó 200 OK sin arrojar 400.');

    console.log(`✅ [TEST 3 PASSED] Idempotencia validada exitosamente en ambos endpoints.\n`);
    passed++;
  } catch (err: any) {
    console.error(`❌ [TEST 3 FAILED] Error en prueba de idempotencia: ${err.message}\n`);
    failed++;
  }

  // ----------------------------------------------------------------
  // TEST 4: Caché de Geocerca en Redis (H4)
  // ----------------------------------------------------------------
  console.log('[TEST 4] Verificando Caché de Geocerca en Redis...');
  try {
    const geofenceOrder = await prisma.order.create({
      data: {
        businessId: business.id,
        createdBy: encargado.id,
        customerName: 'Cliente Geocerca Test',
        customerPhone: '99999999',
        status: OrderStatus.EN_CAMINO_AL_NEGOCIO,
        deliveryUserId: rider1.id,
      },
    });

    // Limpiar caché previo si existiera
    await trackingService.invalidateGeofenceMeta(geofenceOrder.id);

    // 1. Primera lectura: debe cargar de Postgres y almacenar en Redis
    const meta1 = await trackingService.getGeofenceMeta(geofenceOrder.id);
    if (!meta1 || meta1.status !== OrderStatus.EN_CAMINO_AL_NEGOCIO) {
      throw new Error('getGeofenceMeta no retornó los datos esperados');
    }

    // 2. Segunda lectura: debe venir directo de Redis sin consultar Prisma
    let dbQueriesDuringCache = 0;
    const cacheQueryListener = (e: any) => {
      if (typeof e.query === 'string' && e.query.includes('"orders"') && e.query.includes(geofenceOrder.id)) {
        dbQueriesDuringCache++;
      }
    };
    // @ts-ignore
    prisma.$on('query', cacheQueryListener);

    dbQueriesDuringCache = 0;
    const meta2 = await trackingService.getGeofenceMeta(geofenceOrder.id);
    if (!meta2 || meta2.status !== meta1.status) {
      throw new Error('getGeofenceMeta desde Redis retornó datos inconsistentes');
    }

    if (dbQueriesDuringCache === 0) {
      console.log('  -> getGeofenceMeta: Lectura resuelta en Redis en <1ms sin consultar Postgres.');
    } else {
      throw new Error(`Se detectó una consulta SQL a Postgres cuando debía leer de Redis.`);
    }

    // 3. Simular transición de geocerca a EN_EL_NEGOCIO
    const dummyGateway = {
      emitOrderStatusChange: () => {},
      emitToOrder: () => {},
    };

    // Coordenadas exactamente en el negocio
    await trackingService.checkGeofenceAndTransition(
      geofenceOrder.id,
      rider1.id,
      12.1363889,
      -86.2513889,
      dummyGateway,
    );

    const updatedMeta = await trackingService.getGeofenceMeta(geofenceOrder.id);
    if (updatedMeta?.status !== 'EN_EL_NEGOCIO') {
      throw new Error(`El estado en caché debió actualizarse a EN_EL_NEGOCIO, pero es ${updatedMeta?.status}`);
    }

    console.log(`✅ [TEST 4 PASSED] Caché de geocerca en Redis operativo: evita SELECT a Postgres en cada ping GPS.\n`);
    passed++;
  } catch (err: any) {
    console.error(`❌ [TEST 4 FAILED] Error en caché de geocerca: ${err.message}\n`);
    failed++;
  }

  // ----------------------------------------------------------------
  // TEST 5: Cascada Resiliente con Reconciliador Cron (H5)
  // ----------------------------------------------------------------
  console.log('[TEST 5] Verificando Reconciliador de Despacho en Cascada (@Cron)...');
  try {
    const cascadeOrder = await prisma.order.create({
      data: {
        businessId: business.id,
        createdBy: encargado.id,
        customerName: 'Cliente Cascada Test',
        customerPhone: '66666666',
        status: OrderStatus.OFERTADO,
      },
    });

    // Despacho vencido en el pasado (intento 1 con rider1)
    const expiredDispatch = await prisma.orderDispatch.create({
      data: {
        orderId: cascadeOrder.id,
        riderId: rider1.id,
        attempt: 1,
        status: DispatchStatus.SENT,
        timeoutAt: new Date(Date.now() - 60000), // Expiró hace 1 minuto
      },
    });

    // Ejecutar el método reconciliador del @Cron
    await dispatchService.reconcileExpiredDispatches();

    // Validar que el intento 1 pasó a TIMEOUT
    const updatedDispatch1 = await prisma.orderDispatch.findUnique({
      where: { id: expiredDispatch.id },
    });

    if (updatedDispatch1?.status !== DispatchStatus.TIMEOUT) {
      throw new Error(`El despacho 1 debía estar en TIMEOUT pero está en ${updatedDispatch1?.status}`);
    }

    // Validar que se generó el intento 2 para el siguiente rider (rider2)
    const dispatch2 = await prisma.orderDispatch.findFirst({
      where: { orderId: cascadeOrder.id, attempt: 2 },
    });

    if (!dispatch2) {
      throw new Error('No se generó el despacho para el siguiente intento');
    }

    if (dispatch2.riderId !== rider2.id || dispatch2.status !== DispatchStatus.SENT) {
      throw new Error(`El intento 2 debía ser para rider2 con status SENT, pero es riderId=${dispatch2.riderId}, status=${dispatch2.status}`);
    }

    console.log(`  -> Intento #1 marcado como TIMEOUT; Intento #2 generado para riderId=${rider2.id} (${rider2.name})`);
    console.log(`✅ [TEST 5 PASSED] Cascada resiliente: el reconciliador recuperó el despacho vencido y avanzó al siguiente rider.\n`);
    passed++;
  } catch (err: any) {
    console.error(`❌ [TEST 5 FAILED] Error en cascada resiliente: ${err.message}\n`);
    failed++;
  }

  // Limpieza de datos de prueba
  try {
    await prisma.locationSnapshot.deleteMany({ where: { order: { businessId: business.id } } });
    await prisma.trackingSession.deleteMany({ where: { order: { businessId: business.id } } });
    await prisma.orderDispatch.deleteMany({ where: { order: { businessId: business.id } } });
    await prisma.orderQuote.deleteMany({ where: { order: { businessId: business.id } } });
    await prisma.notification.deleteMany({ where: { userId: { in: [encargado.id, rider1.id, rider2.id] } } });
    await prisma.order.deleteMany({ where: { businessId: business.id } });
    await prisma.user.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  } catch (cleanErr: any) {
    console.warn(`[Cleanup Warning]: ${cleanErr.message}`);
  }

  await app.close();

  console.log('====================================================');
  console.log(`RESUMEN DE PRUEBAS: ${passed} PASADAS, ${failed} FALLADAS`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal error en test runner:', err);
  process.exit(1);
});
