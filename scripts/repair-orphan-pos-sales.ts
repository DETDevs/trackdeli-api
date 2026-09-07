import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function repairOrphanSales() {
  console.log('🔍 Buscando ventas sin caja asignada (cashRegisterId: null)...');

  const orphanSales = await prisma.sale.findMany({
    where: {
      cashRegisterId: null,
      status: 'COMPLETED',
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Encontradas ${orphanSales.length} ventas huérfanas.`);

  if (orphanSales.length === 0) {
    console.log('✓ No hay ventas huérfanas que reparar.');
    return;
  }

  let linkedCount = 0;

  for (const sale of orphanSales) {
    // 1. Buscar caja abierta del mismo cajero y negocio
    let register = await prisma.cashRegister.findFirst({
      where: {
        businessId: sale.businessId,
        cashierId: sale.cashierId,
        openedAt: { lte: sale.createdAt },
        OR: [
          { closedAt: null },
          { closedAt: { gte: sale.createdAt } },
        ],
      },
      orderBy: { openedAt: 'desc' },
    });

    // 2. Si no coincide el cajero, buscar caja abierta del negocio en ese rango
    if (!register) {
      register = await prisma.cashRegister.findFirst({
        where: {
          businessId: sale.businessId,
          openedAt: { lte: sale.createdAt },
          OR: [
            { closedAt: null },
            { closedAt: { gte: sale.createdAt } },
          ],
        },
        orderBy: { openedAt: 'desc' },
      });
    }

    // 3. Fallback: caja actualmente abierta del negocio
    if (!register) {
      register = await prisma.cashRegister.findFirst({
        where: {
          businessId: sale.businessId,
          status: 'OPEN',
        },
        orderBy: { openedAt: 'desc' },
      });
    }

    if (register) {
      await prisma.sale.update({
        where: { id: sale.id },
        data: { cashRegisterId: register.id },
      });
      linkedCount++;
      console.log(`  ✓ Venta ${sale.invoiceNumber} (${sale.id}) vinculada a caja ${register.id}`);
    } else {
      console.log(`  ⚠ No se encontró caja para venta ${sale.invoiceNumber} (${sale.id})`);
    }
  }

  console.log(`\n🎉 ${linkedCount} de ${orphanSales.length} ventas huérfanas fueron vinculadas exitosamente.`);
}

repairOrphanSales()
  .catch((e) => {
    console.error('Error reparando ventas:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
