import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- BACKFILL DE POS_PAYMENTS ---');
  
  // 1. Mostrar conteos por método antes
  console.log('Conteos de pagos ANTES de la migración:');
  const beforeCounts = await prisma.posPayment.groupBy({
    by: ['method'],
    _count: { method: true }
  });
  console.log(beforeCounts);

  // 2. Ejecutar la migración simulada del PrismaService
  const salesWithoutPayments = await prisma.sale.findMany({
    where: { payments: { none: {} } },
    include: { business: true }
  });

  console.log(`\nVentas sin pagos encontrados: ${salesWithoutPayments.length}`);

  let updatedCount = 0;
  for (const sale of salesWithoutPayments) {
    const amountPaid = Number(sale.amountPaid);
    const change = Number(sale.change);
    await prisma.posPayment.create({
      data: {
        saleId: sale.id,
        method: sale.paymentMethod,
        amount: amountPaid - change,
        amountTendered: amountPaid,
        change: change,
        reference: sale.reference,
        currency: sale.business?.currency || 'NIO',
        exchangeRate: 1,
        amountBase: amountPaid - change,
        shiftId: sale.cashRegisterId,
        createdById: sale.cashierId
      }
    });
    updatedCount++;
  }

  console.log(`Migrados: ${updatedCount}`);

  // 3. Mostrar conteos por método despues
  console.log('\nConteos de pagos DESPUÉS de la migración:');
  const afterCounts = await prisma.posPayment.groupBy({
    by: ['method'],
    _count: { method: true }
  });
  console.log(afterCounts);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
