import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import http from 'http';

@Controller('test-throttle')
class TestThrottleController {
  @Get('default')
  getDefault() {
    return { ok: true };
  }

  @Get('strict')
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  getStrict() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 5,
      },
    ]),
  ],
  controllers: [TestThrottleController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
class AppTestModule {}

async function runThrottlerVerification() {
  console.log('--- Iniciando Pruebas de Rate Limiting (ThrottlerGuard) ---');

  const app = await NestFactory.create(AppTestModule, { logger: false });
  await app.listen(0);
  const server = app.getHttpServer();
  const address = server.address();
  const port = typeof address === 'string' ? 0 : address.port;

  function makeRequest(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}${path}`, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        })
        .on('error', reject);
    });
  }

  try {
    // Test strict endpoint limit: 2 req/min
    console.log('Probando endpoint estricto (límite: 2 req/min)...');
    const req1 = await makeRequest('/test-throttle/strict');
    console.log(`Req 1: status=${req1.status}`);
    if (req1.status !== 200) throw new Error(`Esperado 200, recibido ${req1.status}`);

    const req2 = await makeRequest('/test-throttle/strict');
    console.log(`Req 2: status=${req2.status}`);
    if (req2.status !== 200) throw new Error(`Esperado 200, recibido ${req2.status}`);

    const req3 = await makeRequest('/test-throttle/strict');
    console.log(`Req 3 (debe exceder límite): status=${req3.status}, body=${req3.body}`);
    if (req3.status !== 429) throw new Error(`Esperado 429 Too Many Requests, recibido ${req3.status}`);

    console.log('✅ PASS: Exceder el límite devuelve 429 Too Many Requests correctamente');
    console.log('\n🎉 ¡TODAS LAS PRUEBAS DE RATE LIMITING PASARON EXITOSAMENTE!');
  } finally {
    await app.close();
  }
}

runThrottlerVerification().catch((err) => {
  console.error('❌ ERROR en pruebas de rate limiting:', err);
  process.exit(1);
});
