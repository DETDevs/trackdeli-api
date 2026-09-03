const { io } = require('socket.io-client');

const API_BASE = 'http://localhost:3000/api/v1';
const WS_BASE = 'http://localhost:3000/tracking';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(method, path, body = null, token = null) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function runTests() {
  console.log('🚀 Iniciando pruebas E2E del Feature: Clientes Recurrentes con Geolocalización...\n');

  // 1. Iniciar sesión como SuperAdmin
  console.log('1️⃣ Autenticando como SuperAdmin...');
  const superadminRes = await request('POST', '/auth/login', {
    email: 'superadmin@trackdeli.com',
    password: 'SuperAdmin2026!',
  });
  const superadminToken = superadminRes.accessToken;
  console.log('   ✓ SuperAdmin autenticado');

  // 2. Iniciar sesión como Encargado de Negocio A (Pollos El Buen Sabor)
  console.log('2️⃣ Autenticando como Encargado Negocio A (carlos@demo.com)...');
  const encResA = await request('POST', '/auth/login', {
    email: 'carlos@demo.com',
    password: 'demo123',
  });
  const tokenA = encResA.accessToken;
  const userA = encResA.user;
  const businessIdA = userA.businessId;
  console.log(`   ✓ Encargado A autenticado (businessId: ${businessIdA})`);

  // 3. Crear o autenticar Encargado de Negocio B (Pizza Roma)
  console.log('3️⃣ Creando/Obteniendo Negocio B (Pizza Roma) para probar multi-tenant...');
  let businessIdB;
  let tokenB;

  try {
    const encResB = await request('POST', '/auth/login', {
      email: 'encargado_pizzaroma@demo.com',
      password: 'Password123!',
    });
    tokenB = encResB.accessToken;
    businessIdB = encResB.user.businessId;
    console.log(`   ✓ Negocio B existente encontrado (businessId: ${businessIdB})`);
  } catch (err) {
    // Crear Negocio B con SuperAdmin
    const newBizRes = await request(
      'POST',
      '/superadmin/businesses',
      {
        name: 'Pizza Roma Test',
        type: 'Pizzería',
        encargado: {
          name: 'Encargado Pizza Roma',
          email: 'encargado_pizzaroma@demo.com',
          password: 'Password123!',
          phone: '+50588889999',
        },
      },
      superadminToken,
    );
    businessIdB = newBizRes.business.id;

    // Login B
    const encResB = await request('POST', '/auth/login', {
      email: 'encargado_pizzaroma@demo.com',
      password: 'Password123!',
    });
    tokenB = encResB.accessToken;
    console.log(`   ✓ Negocio B creado y autenticado (businessId: ${businessIdB})`);
  }

  // Asegurar membresía activa para Negocio B
  try {
    const memRes = await request(
      'POST',
      '/superadmin/memberships',
      {
        businessId: businessIdB,
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        amount: 50,
        currency: 'USD',
        paymentMethod: 'TRANSFERENCIA',
        status: 'ACTIVE',
      },
      superadminToken,
    );
    console.log('   ✓ Membresía activa asignada/verificada para Negocio B (id: ' + memRes.id + ')');
  } catch (err) {
    console.log('   ℹ Info membresía: ' + (err.data?.message || err.message));
  }

  // 4. Probar Multi-Tenant Isolation en creación / upsert
  console.log('\n4️⃣ Probando aislamiento multi-tenant con el mismo número de teléfono...');
  const sharedPhone = '+50589991122';

  // Negocio A crea pedido con cliente Juan Pérez (Managua)
  await request(
    'POST',
    '/orders',
    {
      customerName: 'Juan Pérez Managua',
      customerPhone: sharedPhone,
      destinationAddress: 'Rotonda Metrocentro 2c al lago',
      destinationLat: 12.136389,
      destinationLng: -86.271389,
      deliveryPaymentStatus: 'PAGADO',
      deliveryFee: 60,
    },
    tokenA,
  );

  // Negocio B crea pedido con el MISMO número pero cliente Juanita Roma (Granada)
  await request(
    'POST',
    '/orders',
    {
      customerName: 'Juanita Roma Granada',
      customerPhone: sharedPhone,
      destinationAddress: 'Calle La Calzada, Granada',
      destinationLat: 11.9298,
      destinationLng: -85.9554,
      deliveryPaymentStatus: 'PAGADO',
      deliveryFee: 80,
    },
    tokenB,
  );

  // 5. Búsqueda y Lookup Scoped
  console.log('5️⃣ Verificando búsqueda y lookup por negocio...');

  // Búsqueda en Negocio A
  const searchResA = await request(
    'GET',
    `/businesses/${businessIdA}/customers/search?q=Juan`,
    null,
    tokenA,
  );
  console.log(`   ✓ Negocio A búsqueda ("Juan"): ${searchResA.length} resultado(s)`);
  const matchA = searchResA.find((c) => c.phone === sharedPhone);
  if (matchA && matchA.name === 'Juan Pérez Managua') {
    console.log(`   ✅ Correcto: Negocio A ve solo a "${matchA.name}"`);
  } else {
    throw new Error(`Fallo multi-tenant: Negocio A obtuvo: ${JSON.stringify(matchA)}`);
  }

  // Búsqueda en Negocio B
  const searchResB = await request(
    'GET',
    `/businesses/${businessIdB}/customers/search?q=Juan`,
    null,
    tokenB,
  );
  console.log(`   ✓ Negocio B búsqueda ("Juan"): ${searchResB.length} resultado(s)`);
  const matchB = searchResB.find((c) => c.phone === sharedPhone);
  if (matchB && matchB.name === 'Juanita Roma Granada') {
    console.log(`   ✅ Correcto: Negocio B ve solo a "${matchB.name}"`);
  } else {
    throw new Error(`Fallo multi-tenant: Negocio B obtuvo: ${JSON.stringify(matchB)}`);
  }

  // Lookup exacto en Negocio A
  const lookupResA = await request(
    'GET',
    `/businesses/${businessIdA}/customers/lookup?phone=${encodeURIComponent(sharedPhone)}`,
    null,
    tokenA,
  );
  console.log(`   ✅ Lookup A retornó: "${lookupResA.name}" (isLocationRecent: ${lookupResA.isLocationRecent})`);

  // 6. Generación de Link de Confirmación de Ubicación (con { phone, name } y upsert)
  console.log('\n6️⃣ Generando link de confirmación de 48h con body { phone, name } (upsert automático)...');
  const testPhoneNew = '+50577770001';
  const testNameNew = 'Cliente Nuevo Sin Pedido';

  const linkResBody = await request(
    'POST',
    '/customers/location-confirmation-link',
    {
      phone: testPhoneNew,
      name: testNameNew,
    },
    tokenA,
  );
  console.log(`   ✓ Link generado por body: token=${linkResBody.token}`);
  console.log(`   ✓ CustomerId creado/asociado: ${linkResBody.customerId}`);
  console.log(`   ✓ ConfirmationUrl: ${linkResBody.confirmationUrl}`);

  if (!linkResBody.customerId || !linkResBody.confirmationUrl || !linkResBody.token) {
    throw new Error(`Fallo en respuesta de POST /customers/location-confirmation-link: ${JSON.stringify(linkResBody)}`);
  }

  const customerIdA = linkResBody.customerId;
  const linkRes = linkResBody;

  // 7. Acceso público sin JWT vía token exclusivo de confirm-location
  console.log('\n7️⃣ Consultando sesión pública por token en /customers/confirm-location/:token (sin auth)...');
  const sessionRes = await request(
    'GET',
    `/customers/confirm-location/${linkRes.token}`,
  );
  console.log(`   ✅ Sesión válida: Cliente="${sessionRes.name}", CustomerId="${sessionRes.customerId}", Negocio="${sessionRes.business.name}", Expired=${sessionRes.expired}`);

  if (!sessionRes.customerId || !sessionRes.name || sessionRes.expired !== false) {
    throw new Error(`Respuesta inválida en /customers/confirm-location/:token: ${JSON.stringify(sessionRes)}`);
  }

  // 8. Verificación de WebSockets y Aislamiento de Salas
  console.log('\n8️⃣ Conectando WebSockets a salas business...');
  const socketA = io(WS_BASE, { transports: ['websocket'] });
  const socketB = io(WS_BASE, { transports: ['websocket'] });

  await new Promise((resolve) => socketA.on('connect', resolve));
  await new Promise((resolve) => socketB.on('connect', resolve));

  socketA.emit('join_business', { businessId: businessIdA });
  socketB.emit('join_business', { businessId: businessIdB });
  await sleep(300);

  let eventReceivedA = null;
  let eventReceivedB = null;

  socketA.on('customer_location_updated', (data) => {
    eventReceivedA = data;
  });
  socketB.on('customer_location_updated', (data) => {
    eventReceivedB = data;
  });

  // 9. Actualizar ubicación vía token
  console.log('\n9️⃣ Actualizando ubicación del cliente con nueva captura GPS...');
  const newLat = 12.140000;
  const newLng = -86.275000;
  const newAddress = 'Plaza Inter 1c al sur';

  const updateRes = await request(
    'PATCH',
    `/customers/${customerIdA}/location`,
    {
      token: linkRes.token,
      latitude: newLat,
      longitude: newLng,
      addressText: newAddress,
    },
  );
  console.log(`   ✓ Ubicación actualizada en DB: lat=${updateRes.lastLatitude}, lng=${updateRes.lastLongitude}`);

  // Esperar evento WebSocket
  await sleep(600);

  if (eventReceivedA && eventReceivedA.customerId === customerIdA && eventReceivedA.latitude === newLat) {
    console.log('   ✅ Sala business:NegocioA recibió el evento customer_location_updated en tiempo real');
  } else {
    throw new Error(`Fallo WebSocket: Negocio A no recibió el evento esperado: ${JSON.stringify(eventReceivedA)}`);
  }

  if (eventReceivedB === null) {
    console.log('   ✅ Aislamiento WebSocket: Negocio B NO recibió el evento de Negocio A (100% aislado)');
  } else {
    throw new Error(`Fallo de privacidad WebSocket: Negocio B recibió datos de Negocio A: ${JSON.stringify(eventReceivedB)}`);
  }

  // Verificar que la sesión ahora refleja sessionStatus: 'RESPONDED' en tiempo real
  const sessionAfterRes = await request(
    'GET',
    `/customers/confirm-location/${linkRes.token}`,
  );
  console.log(`   ✅ Estado de sesión reflejado post-respuesta: sessionStatus="${sessionAfterRes.sessionStatus}", respondedAt="${sessionAfterRes.respondedAt}"`);
  if (sessionAfterRes.sessionStatus !== 'RESPONDED' || !sessionAfterRes.respondedAt) {
    throw new Error(`Se esperaba sessionStatus 'RESPONDED' y respondedAt, recibido: ${JSON.stringify(sessionAfterRes)}`);
  }

  // 10. Confirmación de misma dirección ("Sí, sigo acá")
  console.log('\n🔟 Probando confirmación de misma ubicación ("Sí, sigo acá")...');
  let confirmedEventA = null;
  socketA.on('customer_location_confirmed', (data) => {
    confirmedEventA = data;
  });

  await request(
    'PATCH',
    `/customers/${customerIdA}/location`,
    {
      token: linkRes.token,
      confirmedSameLocation: true,
    },
  );
  await sleep(600);

  if (confirmedEventA && confirmedEventA.customerId === customerIdA) {
    console.log('   ✅ Sala business:NegocioA recibió evento customer_location_confirmed');
  } else {
    throw new Error(`Fallo WebSocket confirmación: ${JSON.stringify(confirmedEventA)}`);
  }

  socketA.disconnect();
  socketB.disconnect();

  console.log('\n🎉 ¡TODAS LAS PRUEBAS E2E PASARON EXITOSAMENTE! 🚀\n');
}

runTests().catch((err) => {
  console.error('\n❌ Error en las pruebas:', err.data || err.message);
  process.exit(1);
});
