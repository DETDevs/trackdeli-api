const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const businesses = await prisma.business.findMany({
    select: { id: true, name: true, taxRate: true, taxEnabled: true, taxIncluded: true }
  });
  console.log('--- NEGOCIOS ---');
  businesses.forEach(b => {
    let warning = '';
    if (b.taxRate > 0 && !b.taxEnabled) warning += ' [! WARNING: taxRate>0 but taxEnabled=false]';
    if (b.taxIncluded) warning += ' [! WARNING: taxIncluded=true]';
    console.log(b.id.substring(0,6) + '... | ' + b.name.padEnd(25) + ' | Rate: ' + b.taxRate + ' | Enabled: ' + b.taxEnabled + ' | Included: ' + b.taxIncluded + warning);
  });

  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const sales = await prisma.sale.findMany({
    where: { createdAt: { gte: twoDaysAgo } },
    select: { id: true, businessId: true, createdAt: true, subtotal: true, taxAmount: true, total: true, business: { select: { taxRate: true } } }
  });
  
  console.log('\n--- VENTAS DE LAS ÚLTIMAS 48H ---');
  let affectedSales = 0;
  sales.forEach(s => {
    if (s.business.taxRate > 0 && s.taxAmount === 0) {
      affectedSales++;
      console.log('[AFECTADA] Sale: ' + s.id.substring(0,8) + ' | Biz: ' + s.businessId.substring(0,8) + ' | Date: ' + s.createdAt.toISOString() + ' | Subtotal: ' + s.subtotal + ' | TaxAmt: ' + s.taxAmount + ' | Total: ' + s.total);
    }
  });
  if (affectedSales === 0) console.log('Ninguna venta afectada encontrada.');
  
  await prisma.$disconnect();
}
run();
