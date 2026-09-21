import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductDto } from '../src/modules/pos/products/dto/create-product.dto';
import { CreateAppointmentDto } from '../src/modules/booking/dto/create-appointment.dto';
import { CreateOrderDto } from '../src/modules/orders/dto/create-order.dto';
import { CreateSaleDto } from '../src/modules/pos/sales/dto/create-sale.dto';
import { DeliveryPaymentStatus, PosPaymentMethod } from '@prisma/client';
import { SanitizeText } from '../src/common/decorators/sanitize-text.decorator';

class TestDto {
  @SanitizeText()
  text: string;
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILURE: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

async function runTests() {
  console.log('--- Iniciando Pruebas de Sanitización de Inputs ---');

  // Test 1: Script tag stripped
  const test1 = plainToInstance(TestDto, { text: '<script>alert(1)</script>' });
  assert(test1.text === '', `Script tag debe ser eliminado completamente (recibido: "${test1.text}")`);

  // Test 2: Img tag with onerror stripped
  const test2 = plainToInstance(TestDto, { text: 'Corte de cabello <img src=x onerror=alert(2)> con estilo' });
  assert(
    test2.text === 'Corte de cabello  con estilo',
    `Img tag con onerror debe ser eliminado (recibido: "${test2.text}")`
  );

  // Test 3: Tag stripped, inner text preserved
  const test3 = plainToInstance(TestDto, { text: '<a href="javascript:alert(1)">Click me</a>' });
  assert(test3.text === 'Click me', `Tag a href javascript debe ser eliminado preservando texto (recibido: "${test3.text}")`);

  // Test 4: Normal text with accents, punctuation, newlines preserved
  const legitText = '¡Hola Mundo!\nCafé con Leche — Dirección: 2c al sur #123. ¿100% seguro?';
  const test4 = plainToInstance(TestDto, { text: legitText });
  assert(test4.text === legitText, `Texto legítimo con tildes y saltos de línea debe mantenerse intacto (recibido: "${test4.text}")`);

  console.log('\n--- Probando DTOs Reales del Sistema ---');

  // Test 5: CreateProductDto
  const productDto = plainToInstance(CreateProductDto, {
    name: 'Hamburguesa <b>Especial</b>',
    description: '<script>stealCookies()</script>Deliciosa hamburguesa con queso',
    price: 150,
    categoryId: 'cat-123',
  });
  assert(
    productDto.name === 'Hamburguesa Especial',
    `CreateProductDto.name sanitizado correctamente (recibido: "${productDto.name}")`
  );
  assert(
    productDto.description === 'Deliciosa hamburguesa con queso',
    `CreateProductDto.description sanitizado correctamente (recibido: "${productDto.description}")`
  );

  // Test 6: CreateAppointmentDto
  const appointmentDto = plainToInstance(CreateAppointmentDto, {
    serviceId: 'srv-1',
    scheduledAt: '2026-10-01T10:00:00Z',
    customerName: '<script>alert("hacked")</script>Juan Pérez',
    customerPhone: '+50588888888',
  });
  assert(
    appointmentDto.customerName === 'Juan Pérez',
    `CreateAppointmentDto.customerName sanitizado correctamente (recibido: "${appointmentDto.customerName}")`
  );

  // Test 7: CreateOrderDto
  const orderDto = plainToInstance(CreateOrderDto, {
    customerName: 'María López <iframe src="..."></iframe>',
    customerPhone: '+50512345678',
    destinationAddress: 'Rotonda El Güegüense <script>fetch("evil.com")</script>',
    destinationLat: 12.123,
    destinationLng: -86.123,
    description: 'Dejar en recepción <b>urgente</b>',
    deliveryPaymentStatus: DeliveryPaymentStatus.GRATIS,
  });
  assert(
    orderDto.customerName === 'María López ',
    `CreateOrderDto.customerName sanitizado (recibido: "${orderDto.customerName}")`
  );
  assert(
    orderDto.destinationAddress === 'Rotonda El Güegüense ',
    `CreateOrderDto.destinationAddress sanitizado (recibido: "${orderDto.destinationAddress}")`
  );
  assert(
    orderDto.description === 'Dejar en recepción urgente',
    `CreateOrderDto.description sanitizado (recibido: "${orderDto.description}")`
  );

  // Test 8: CreateSaleDto
  const saleDto = plainToInstance(CreateSaleDto, {
    items: [],
    paymentMethod: PosPaymentMethod.EFECTIVO,
    customerName: '<svg onload="alert(1)">Cliente</svg>',
    notes: 'Nota con <style>body{display:none}</style>contenido',
  });
  assert(
    saleDto.customerName === 'Cliente',
    `CreateSaleDto.customerName sanitizado (recibido: "${saleDto.customerName}")`
  );
  assert(
    saleDto.notes === 'Nota con contenido',
    `CreateSaleDto.notes sanitizado (recibido: "${saleDto.notes}")`
  );

  console.log('\n🎉 ¡TODAS LAS PRUEBAS DE SANITIZACIÓN PASARON EXITOSAMENTE!');
}

runTests().catch((err) => {
  console.error('Error durante pruebas:', err);
  process.exit(1);
});
