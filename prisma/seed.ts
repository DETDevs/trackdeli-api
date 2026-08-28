import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting seed...');

  // SuperAdmin user
  const superAdminPassword = await bcrypt.hash('SuperAdmin2026!', 10);
  const superadmin = await prisma.user.upsert({
    where: { email: 'superadmin@trackdeli.com' },
    update: {
      role: 'SUPERADMIN',
      isActive: true,
    },
    create: {
      email: 'superadmin@trackdeli.com',
      passwordHash: superAdminPassword,
      name: 'Super Admin',
      role: 'SUPERADMIN',
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
      role: 'ENCARGADO',
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
      role: 'REPARTIDOR',
      isAvailable: true,
      vehicleType: 'MOTO',
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
      role: 'REPARTIDOR',
      isAvailable: true,
      vehicleType: 'BICICLETA',
      vehiclePlate: '',
      vehicleColor: 'Azul',
    },
  });
  console.log(`Upserted repartidor independiente: ${repartidor2.name}`);

  // ─── POS: Habilitar POS para el negocio demo ───
  await prisma.business.update({
    where: { id: business.id },
    data: {
      hasPOS: true,
      taxRate: 15,
      currency: 'NIO',
      invoicePrefix: 'FAC',
      invoiceCounter: 1,
      posAddress: 'Carretera Ticuantepe Km 12, Managua',
      posPhone: '+505 8888-7777',
      posFooter: '¡Gracias por su compra! Vuelva pronto.',
    },
  });
  console.log('POS habilitado para el negocio demo');

  // Limpiar categorías y productos existentes del demo para re-crear
  await prisma.stockMovement.deleteMany({ where: { businessId: business.id } });
  await prisma.saleItem.deleteMany({ where: { sale: { businessId: business.id } } });
  await prisma.sale.deleteMany({ where: { businessId: business.id } });
  await prisma.product.deleteMany({ where: { businessId: business.id } });
  await prisma.category.deleteMany({ where: { businessId: business.id } });
  await prisma.supplier.deleteMany({ where: { businessId: business.id } });

  // Categorías
  const [catComida, catBebidas, catPostres] = await Promise.all([
    prisma.category.create({ data: { businessId: business.id, name: 'Comida', color: '#F59E0B', icon: 'utensils' } }),
    prisma.category.create({ data: { businessId: business.id, name: 'Bebidas', color: '#3B82F6', icon: 'cup-soda' } }),
    prisma.category.create({ data: { businessId: business.id, name: 'Postres', color: '#EC4899', icon: 'cake' } }),
  ]);
  console.log('Categorías POS creadas');

  // Proveedor demo
  const supplierDemo = await prisma.supplier.create({
    data: {
      businessId: business.id,
      name: 'Distribuidora El Sol',
      phone: '+505 2222-3333',
      email: 'ventas@distribuidoraelsol.com',
    },
  });
  console.log(`Proveedor POS creado: ${supplierDemo.name}`);

  // Productos
  await Promise.all([
    prisma.product.create({
      data: {
        businessId: business.id,
        categoryId: catComida.id,
        supplierId: supplierDemo.id,
        name: 'Pollo Asado Entero',
        description: 'Pollo asado a la leña, entero',
        price: 250,
        cost: 150,
        stock: 20,
        minStock: 5,
        trackStock: true,
      },
    }),
    prisma.product.create({
      data: {
        businessId: business.id,
        categoryId: catBebidas.id,
        supplierId: supplierDemo.id,
        name: 'Coca-Cola 2L',
        barcode: '7501055300921',
        price: 65,
        cost: 40,
        stock: 50,
        minStock: 10,
        trackStock: true,
      },
    }),
    prisma.product.create({
      data: {
        businessId: business.id,
        categoryId: catComida.id,
        name: 'Gallo Pinto',
        description: 'Gallo pinto tradicional nicaragüense',
        price: 80,
        cost: 35,
        stock: 100,
        minStock: 10,
        trackStock: true,
      },
    }),
    prisma.product.create({
      data: {
        businessId: business.id,
        categoryId: catPostres.id,
        name: 'Quesillo',
        price: 40,
        cost: 15,
        stock: 30,
        minStock: 5,
        trackStock: true,
      },
    }),
    prisma.product.create({
      data: {
        businessId: business.id,
        categoryId: catBebidas.id,
        name: 'Agua Purificada 500ml',
        barcode: '7401000930016',
        price: 15,
        cost: 8,
        stock: 80,
        minStock: 20,
        trackStock: true,
      },
    }),
  ]);
  console.log('Productos POS creados (5 productos)');

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
