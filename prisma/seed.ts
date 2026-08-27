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
