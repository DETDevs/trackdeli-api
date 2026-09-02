import {
  CashStatus,
  MovementType,
  PaymentMethod,
  PosPaymentMethod,
  PrismaClient,
  SaleStatus,
  StockMovementType,
  UserRole,
  VehicleType,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function seedPOS(prisma: PrismaClient, businessId: string, cashierId: string) {
  console.log('\n--- Seeding Módulo POS ---');

  // 1. Actualizar configuración POS del negocio demo
  await prisma.business.update({
    where: { id: businessId },
    data: {
      hasPOS: true,
      taxRate: 0, // Sin IVA para simplificar pruebas
      currency: 'NIO',
      invoicePrefix: 'FAC',
      invoiceCounter: 1,
      posAddress: 'Carretera Ticuantepe, Managua, Nicaragua',
      posPhone: '+505 8888-7777',
      posFooter: '¡Gracias por su compra! Vuelva pronto 😊',
    },
  });
  console.log('✓ Configuración POS actualizada');

  // Limpiar datos POS existentes del negocio para re-sembrar limpiamente
  await prisma.cashMovement.deleteMany({ where: { businessId } });
  await prisma.cashRegister.deleteMany({ where: { businessId } });
  await prisma.stockMovement.deleteMany({ where: { businessId } });
  await prisma.saleItem.deleteMany({ where: { sale: { businessId } } });
  await prisma.sale.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
  await prisma.category.deleteMany({ where: { businessId } });
  await prisma.supplier.deleteMany({ where: { businessId } });

  // 2. Categorías
  const categoriesData = [
    { name: 'Pollos', color: '#F59E0B', icon: '🍗' },
    { name: 'Bebidas', color: '#3B82F6', icon: '🥤' },
    { name: 'Acompañantes', color: '#22C55E', icon: '🍚' },
    { name: 'Combos', color: '#EC4899', icon: '🍱' },
    { name: 'Postres', color: '#8B5CF6', icon: '🍮' },
    { name: 'Extras', color: '#6B7280', icon: '➕' },
  ];

  const categories = await Promise.all(
    categoriesData.map((cat) =>
      prisma.category.upsert({
        where: { businessId_name: { businessId, name: cat.name } },
        create: { businessId, name: cat.name, color: cat.color, icon: cat.icon },
        update: { color: cat.color, icon: cat.icon },
      }),
    ),
  );
  console.log(`✓ ${categories.length} categorías creadas`);

  // 3. Proveedor demo
  const supplier = await prisma.supplier.upsert({
    where: { id: 'supplier-demo-001' },
    create: {
      id: 'supplier-demo-001',
      businessId,
      name: 'Distribuidora El Buen Precio',
      phone: '22781234',
      email: 'ventas@buenprecio.com.ni',
      address: 'Mercado Huembes, Managua',
      notes: 'Entrega los martes y jueves',
    },
    update: {
      businessId,
      name: 'Distribuidora El Buen Precio',
      phone: '22781234',
      email: 'ventas@buenprecio.com.ni',
      address: 'Mercado Huembes, Managua',
      notes: 'Entrega los martes y jueves',
    },
  });
  console.log(`✓ Proveedor creado: ${supplier.name}`);

  // 4. Productos
  const products = [
    // POLLOS
    {
      name: 'Pollo Asado Entero',
      categoryName: 'Pollos',
      price: 280,
      cost: 160,
      barcode: '7501001001001',
      stock: 15,
      minStock: 3,
      description: 'Pollo asado entero con chimichurri',
    },
    {
      name: 'Medio Pollo Asado',
      categoryName: 'Pollos',
      price: 150,
      cost: 85,
      barcode: '7501001001002',
      stock: 20,
      minStock: 5,
    },
    {
      name: 'Cuarto de Pollo',
      categoryName: 'Pollos',
      price: 80,
      cost: 45,
      barcode: '7501001001003',
      stock: 30,
      minStock: 8,
    },
    {
      name: 'Pechuga a la Plancha',
      categoryName: 'Pollos',
      price: 95,
      cost: 55,
      barcode: '7501001001004',
      stock: 25,
      minStock: 5,
    },
    {
      name: 'Alitas BBQ (6 unidades)',
      categoryName: 'Pollos',
      price: 120,
      cost: 65,
      barcode: '7501001001005',
      stock: 40,
      minStock: 10,
    },

    // COMBOS
    {
      name: 'Combo Familiar (Pollo + 4 Acompañantes)',
      categoryName: 'Combos',
      price: 380,
      cost: 210,
      barcode: '7501001002001',
      stock: 10,
      minStock: 2,
      description: 'Pollo entero + papas fritas + ensalada + gallo pinto + tortillas',
    },
    {
      name: 'Combo Personal (¼ Pollo + 2 Acompañantes)',
      categoryName: 'Combos',
      price: 130,
      cost: 72,
      barcode: '7501001002002',
      stock: 25,
      minStock: 5,
      description: '¼ de pollo + papas fritas + refresco',
    },
    {
      name: 'Combo Pareja (½ Pollo + 3 Acompañantes)',
      categoryName: 'Combos',
      price: 250,
      cost: 138,
      barcode: '7501001002003',
      stock: 15,
      minStock: 3,
    },

    // ACOMPAÑANTES
    {
      name: 'Papas Fritas',
      categoryName: 'Acompañantes',
      price: 35,
      cost: 15,
      barcode: '7501001003001',
      stock: 50,
      minStock: 10,
    },
    {
      name: 'Gallo Pinto',
      categoryName: 'Acompañantes',
      price: 30,
      cost: 12,
      barcode: '7501001003002',
      stock: 60,
      minStock: 15,
    },
    {
      name: 'Ensalada de Repollo',
      categoryName: 'Acompañantes',
      price: 25,
      cost: 10,
      barcode: '7501001003003',
      stock: 40,
      minStock: 10,
    },
    {
      name: 'Tortillas (4 unidades)',
      categoryName: 'Acompañantes',
      price: 20,
      cost: 8,
      barcode: '7501001003004',
      stock: 80,
      minStock: 20,
    },
    {
      name: 'Yuca Frita',
      categoryName: 'Acompañantes',
      price: 30,
      cost: 12,
      barcode: '7501001003005',
      stock: 35,
      minStock: 8,
    },

    // BEBIDAS
    {
      name: 'Coca-Cola 2L',
      categoryName: 'Bebidas',
      price: 65,
      cost: 42,
      barcode: '7501055300921',
      stock: 30,
      minStock: 10,
      supplierId: supplier.id,
    },
    {
      name: 'Coca-Cola 500ml',
      categoryName: 'Bebidas',
      price: 30,
      cost: 18,
      barcode: '7501055301234',
      stock: 60,
      minStock: 15,
      supplierId: supplier.id,
    },
    {
      name: 'Agua Purificada 500ml',
      categoryName: 'Bebidas',
      price: 15,
      cost: 8,
      barcode: '7501055305678',
      stock: 48,
      minStock: 12,
    },
    {
      name: 'Refresco Natural (Vaso)',
      categoryName: 'Bebidas',
      price: 25,
      cost: 8,
      barcode: '7501055309999',
      stock: 999,
      minStock: 0,
      trackStock: false, // no controla stock
      description: 'Tamarindo, horchata o cebada',
    },

    // POSTRES
    {
      name: 'Tres Leches (Porción)',
      categoryName: 'Postres',
      price: 45,
      cost: 20,
      barcode: '7501001004001',
      stock: 12,
      minStock: 3,
    },
    {
      name: 'Flan de Caramelo',
      categoryName: 'Postres',
      price: 40,
      cost: 18,
      barcode: '7501001004002',
      stock: 8,
      minStock: 2,
    },

    // EXTRAS
    {
      name: 'Salsa Chimichurri (Extra)',
      categoryName: 'Extras',
      price: 10,
      cost: 3,
      barcode: '7501001005001',
      stock: 100,
      minStock: 20,
    },
  ];

  const createdProducts: Record<string, any> = {};
  for (const p of products) {
    const category = categories.find((c) => c.name === p.categoryName);
    const product = await prisma.product.upsert({
      where: {
        businessId_barcode: {
          businessId,
          barcode: p.barcode ?? `NO-BAR-${p.name}`,
        },
      },
      create: {
        businessId,
        categoryId: category?.id,
        supplierId: (p as any).supplierId ?? null,
        name: p.name,
        description: (p as any).description,
        barcode: p.barcode,
        price: p.price,
        cost: p.cost,
        stock: p.stock,
        minStock: p.minStock,
        trackStock: (p as any).trackStock ?? true,
      },
      update: {
        price: p.price,
        cost: p.cost,
        stock: p.stock,
        minStock: p.minStock,
      },
    });
    createdProducts[p.name] = product;
  }
  console.log(`✓ ${products.length} productos creados`);

  // 5. Ventas históricas (últimos 30 días)
  const randomDate = (daysAgo: number) => {
    const date = new Date();
    date.setDate(date.getDate() - Math.floor(Math.random() * daysAgo));
    date.setHours(
      Math.floor(Math.random() * 12) + 9, // 9am - 9pm
      Math.floor(Math.random() * 60),
      0,
      0,
    );
    return date;
  };

  const saleTemplates = [
    {
      items: [
        { productName: 'Combo Personal (¼ Pollo + 2 Acompañantes)', qty: 1, price: 130 },
        { productName: 'Coca-Cola 500ml', qty: 1, price: 30 },
      ],
      paymentMethod: PosPaymentMethod.EFECTIVO,
      amountPaid: 200,
    },
    {
      items: [
        { productName: 'Combo Familiar (Pollo + 4 Acompañantes)', qty: 1, price: 380 },
        { productName: 'Coca-Cola 2L', qty: 1, price: 65 },
      ],
      paymentMethod: PosPaymentMethod.EFECTIVO,
      amountPaid: 500,
    },
    {
      items: [
        { productName: 'Cuarto de Pollo', qty: 3, price: 80 },
        { productName: 'Gallo Pinto', qty: 3, price: 30 },
        { productName: 'Tortillas (4 unidades)', qty: 2, price: 20 },
      ],
      paymentMethod: PosPaymentMethod.EFECTIVO,
      amountPaid: 400,
    },
    {
      items: [
        { productName: 'Pollo Asado Entero', qty: 1, price: 280 },
        { productName: 'Papas Fritas', qty: 2, price: 35 },
        { productName: 'Refresco Natural (Vaso)', qty: 2, price: 25 },
      ],
      paymentMethod: PosPaymentMethod.TARJETA,
      amountPaid: 400,
    },
    {
      items: [
        { productName: 'Alitas BBQ (6 unidades)', qty: 1, price: 120 },
        { productName: 'Coca-Cola 500ml', qty: 2, price: 30 },
      ],
      paymentMethod: PosPaymentMethod.EFECTIVO,
      amountPaid: 200,
    },
    {
      items: [
        { productName: 'Combo Pareja (½ Pollo + 3 Acompañantes)', qty: 1, price: 250 },
        { productName: 'Tres Leches (Porción)', qty: 2, price: 45 },
      ],
      paymentMethod: PosPaymentMethod.TRANSFERENCIA,
      amountPaid: 340,
    },
    {
      items: [
        { productName: 'Pollo Asado Entero', qty: 2, price: 280 },
        { productName: 'Papas Fritas', qty: 4, price: 35 },
        { productName: 'Ensalada de Repollo', qty: 3, price: 25 },
        { productName: 'Coca-Cola 2L', qty: 2, price: 65 },
      ],
      paymentMethod: PosPaymentMethod.EFECTIVO,
      amountPaid: 1100,
    },
    {
      items: [
        { productName: 'Pechuga a la Plancha', qty: 1, price: 95 },
        { productName: 'Gallo Pinto', qty: 1, price: 30 },
        { productName: 'Agua Purificada 500ml', qty: 1, price: 15 },
      ],
      paymentMethod: PosPaymentMethod.EFECTIVO,
      amountPaid: 150,
    },
  ];

  let invoiceCounter = 1;
  for (let i = 0; i < 60; i++) {
    const template = saleTemplates[i % saleTemplates.length];
    const saleDate = randomDate(30);

    const subtotal = template.items.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    );
    const total = subtotal;
    const change = template.amountPaid - total;

    const invoiceNumber = `FAC-${String(invoiceCounter).padStart(4, '0')}`;
    invoiceCounter++;

    await prisma.sale.create({
      data: {
        businessId,
        cashierId,
        invoiceNumber,
        invoiceDate: saleDate,
        subtotal,
        discountAmount: 0,
        taxAmount: 0,
        total,
        paymentMethod: template.paymentMethod,
        amountPaid: template.amountPaid,
        change,
        status: SaleStatus.COMPLETED,
        createdAt: saleDate,
        items: {
          create: template.items.map((item) => {
            const product = createdProducts[item.productName];
            return {
              productId: product?.id ?? null,
              productName: item.productName,
              unitPrice: item.price,
              quantity: item.qty,
              discount: 0,
              subtotal: item.price * item.qty,
            };
          }),
        },
      },
    });
  }
  console.log(`✓ 60 ventas históricas creadas`);

  // Actualizar el contador de facturas en el negocio
  await prisma.business.update({
    where: { id: businessId },
    data: { invoiceCounter },
  });

  // 6. Movimientos de caja (últimos 7 días)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(8, 0, 0, 0);

  const yesterdayClose = new Date(yesterday);
  yesterdayClose.setHours(20, 30, 0, 0);

  const register1 = await prisma.cashRegister.create({
    data: {
      businessId,
      cashierId,
      openedAt: yesterday,
      closedAt: yesterdayClose,
      openingCash: 500,
      closingCash: 3250,
      expectedCash: 3180,
      difference: 70, // sobrante de C$70
      totalSales: 4800,
      totalCash: 3200,
      totalCard: 1200,
      totalTransfer: 400,
      status: CashStatus.CLOSED,
      notes: 'Turno normal, todo en orden',
    },
  });

  await prisma.cashMovement.createMany({
    data: [
      {
        businessId,
        cashRegisterId: register1.id,
        userId: cashierId,
        type: MovementType.ENTRADA,
        amount: 200,
        concept: 'Fondo de cambio adicional',
        createdAt: new Date(yesterday.getTime() + 2 * 60 * 60 * 1000),
      },
      {
        businessId,
        cashRegisterId: register1.id,
        userId: cashierId,
        type: MovementType.SALIDA,
        amount: 350,
        concept: 'Pago a proveedor — Distribuidora El Buen Precio',
        createdAt: new Date(yesterday.getTime() + 5 * 60 * 60 * 1000),
      },
      {
        businessId,
        cashRegisterId: register1.id,
        userId: cashierId,
        type: MovementType.SALIDA,
        amount: 120,
        concept: 'Gastos de limpieza y desinfección',
        createdAt: new Date(yesterday.getTime() + 8 * 60 * 60 * 1000),
      },
    ],
  });

  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  twoDaysAgo.setHours(8, 0, 0, 0);

  const twoDaysAgoClose = new Date(twoDaysAgo);
  twoDaysAgoClose.setHours(21, 0, 0, 0);

  await prisma.cashRegister.create({
    data: {
      businessId,
      cashierId,
      openedAt: twoDaysAgo,
      closedAt: twoDaysAgoClose,
      openingCash: 500,
      closingCash: 2800,
      expectedCash: 2850,
      difference: -50, // faltante de C$50
      totalSales: 3900,
      totalCash: 2850,
      totalCard: 750,
      totalTransfer: 300,
      status: CashStatus.CLOSED,
      notes: 'Faltante de C$50 — revisar con cajero',
    },
  });

  // Turno actual abierto hoy
  const todayOpen = new Date();
  todayOpen.setHours(8, 0, 0, 0);

  await prisma.cashRegister.create({
    data: {
      businessId,
      cashierId,
      openedAt: todayOpen,
      openingCash: 500,
      status: CashStatus.OPEN,
    },
  });
  console.log(`✓ 3 turnos de caja creados (2 cerrados, 1 abierto hoy)`);

  // 7. Movimientos de inventario históricos
  const polloEntero = createdProducts['Pollo Asado Entero'];
  const cocaCola2L = createdProducts['Coca-Cola 2L'];

  await prisma.stockMovement.createMany({
    data: [
      {
        businessId,
        productId: polloEntero.id,
        userId: cashierId,
        type: StockMovementType.COMPRA,
        quantity: 20,
        stockBefore: 5,
        stockAfter: 25,
        cost: 160,
        concept: 'Compra semanal de pollos',
        reference: 'COMP-001',
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
      {
        businessId,
        productId: cocaCola2L.id,
        userId: cashierId,
        type: StockMovementType.COMPRA,
        quantity: 24,
        stockBefore: 8,
        stockAfter: 32,
        cost: 42,
        concept: 'Compra de bebidas — Distribuidora El Buen Precio',
        reference: 'COMP-002',
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
      {
        businessId,
        productId: polloEntero.id,
        userId: cashierId,
        type: StockMovementType.PERDIDA,
        quantity: -2,
        stockBefore: 18,
        stockAfter: 16,
        cost: 160,
        concept: 'Merma — pollos vencidos',
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      },
    ],
  });
  console.log(`✓ Movimientos de stock creados`);
  console.log('--- Seed POS Finalizado Exitosamente ---\n');
}

async function main() {
  console.log('Starting seed...');

  // SuperAdmin user
  const superAdminPassword = await bcrypt.hash('SuperAdmin2026!', 10);
  const superadmin = await prisma.user.upsert({
    where: { email: 'superadmin@trackdeli.com' },
    update: {
      role: UserRole.SUPERADMIN,
      isActive: true,
    },
    create: {
      email: 'superadmin@trackdeli.com',
      passwordHash: superAdminPassword,
      name: 'Super Admin',
      role: UserRole.SUPERADMIN,
      businessId: null,
      isActive: true,
    },
  });
  console.log(`Upserted SuperAdmin: ${superadmin.email}`);

  // 1 negocio: "Pollos El Buen Sabor", tipo "comida"
  let business = await prisma.business.findFirst({
    where: { name: 'Pollos El Buen Sabor' },
  });
  if (!business) {
    business = await prisma.business.create({
      data: {
        name: 'Pollos El Buen Sabor',
        type: 'comida',
      },
    });
    console.log(`Created business: ${business.name}`);
  } else {
    console.log(`Business already exists: ${business.name}`);
  }

  // Membresía activa para el negocio demo
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endDate = new Date(now.getFullYear() + 1, now.getMonth(), 1);

  await prisma.membership.upsert({
    where: { id: 'demo-membership-' + business.id },
    update: {
      status: 'ACTIVE',
      startDate,
      endDate,
    },
    create: {
      id: 'demo-membership-' + business.id,
      businessId: business.id,
      status: 'ACTIVE',
      startDate,
      endDate,
      amount: 50,
      currency: 'USD',
      paymentMethod: PaymentMethod.TRANSFERENCIA,
      createdBy: superadmin.id,
    },
  });
  console.log('Membresía activa para negocio demo creada/actualizada');

  const passwordHash = await bcrypt.hash('demo123', 10);

  // 1 encargado: "Carlos López"
  const encargado = await prisma.user.upsert({
    where: { email: 'carlos@demo.com' },
    update: { businessId: business.id },
    create: {
      businessId: business.id,
      name: 'Carlos López',
      email: 'carlos@demo.com',
      passwordHash,
      role: UserRole.ENCARGADO,
    },
  });
  console.log(`Upserted encargado: ${encargado.name}`);

  // 2 repartidores independientes
  const repartidor1 = await prisma.user.upsert({
    where: { email: 'juan@demo.com' },
    update: {},
    create: {
      businessId: null,
      name: 'Juan Pérez',
      email: 'juan@demo.com',
      passwordHash,
      role: UserRole.REPARTIDOR,
      isAvailable: true,
      vehicleType: VehicleType.MOTO,
      vehiclePlate: 'M234-567',
      vehicleColor: 'Rojo',
    },
  });
  console.log(`Upserted repartidor independiente: ${repartidor1.name}`);

  const repartidor2 = await prisma.user.upsert({
    where: { email: 'maria@demo.com' },
    update: {},
    create: {
      businessId: null,
      name: 'María García',
      email: 'maria@demo.com',
      passwordHash,
      role: UserRole.REPARTIDOR,
      isAvailable: true,
      vehicleType: VehicleType.BICICLETA,
      vehiclePlate: '',
      vehicleColor: 'Azul',
    },
  });
  console.log(`Upserted repartidor independiente: ${repartidor2.name}`);

  // Ejecutar seed de POS con datos realistas
  await seedPOS(prisma, business.id, encargado.id);

  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
