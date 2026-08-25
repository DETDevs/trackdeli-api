import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting seed...');

  // 1 negocio: "Pollos El Buen Sabor", tipo "comida"
  const business = await prisma.business.create({
    data: {
      name: 'Pollos El Buen Sabor',
      type: 'comida',
    },
  });
  console.log(`Created business: ${business.name}`);

  const passwordHash = await bcrypt.hash('demo123', 10);

  // 1 encargado: "Carlos López"
  const encargado = await prisma.user.create({
    data: {
      businessId: business.id,
      name: 'Carlos López',
      email: 'carlos@demo.com',
      passwordHash,
      role: 'ENCARGADO',
    },
  });
  console.log(`Created encargado: ${encargado.name}`);

  // 2 repartidores independientes
  const repartidor1 = await prisma.user.create({
    data: {
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
  console.log(`Created repartidor independiente: ${repartidor1.name}`);

  const repartidor2 = await prisma.user.create({
    data: {
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
  console.log(`Created repartidor independiente: ${repartidor2.name}`);

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
