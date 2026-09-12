import { PrismaClient, BusinessProductType, BusinessProductStatus, BusinessProductAction } from '@prisma/client';

async function backfill() {
  console.log('--- MIGRACIÓN / BACKFILL DE PRODUCTOS POR NEGOCIO (DELIVERY & POS) ---');
  const prisma = new PrismaClient();
  await prisma.$connect();

  try {
    const businesses = await prisma.business.findMany({
      include: {
        productSubscriptions: true,
      },
    });

    console.log(`Encontrados ${businesses.length} negocios para verificar/migrar.`);

    let deliveryCreated = 0;
    let posCreated = 0;
    let skipped = 0;

    for (const b of businesses) {
      // 1. DELIVERY
      const existingDelivery = b.productSubscriptions.find(
        (s) => s.productType === BusinessProductType.DELIVERY,
      );

      if (!existingDelivery) {
        await prisma.businessProductSubscription.create({
          data: {
            businessId: b.id,
            productType: BusinessProductType.DELIVERY,
            status: BusinessProductStatus.ACTIVE,
            commissionRate: b.commissionRate,
            altCommissionRate: b.altCommissionRate,
            altCommissionDistanceKm: b.altCommissionDistanceKm,
            dispatchTimeoutMin: b.dispatchTimeoutMin,
            activatedAt: b.createdAt,
            activatedBy: 'system-migration',
          },
        });

        await prisma.businessProductAuditLog.create({
          data: {
            businessId: b.id,
            productType: BusinessProductType.DELIVERY,
            action: BusinessProductAction.ACTIVATED,
            performedBy: 'system-migration',
            reason: 'Backfill inicial por migración a productos independientes',
            metadata: {
              initialCommissionRate: b.commissionRate,
              initialAltCommissionRate: b.altCommissionRate,
              initialAltCommissionDistanceKm: b.altCommissionDistanceKm,
              initialDispatchTimeoutMin: b.dispatchTimeoutMin,
            },
          },
        });
        deliveryCreated++;
      }

      // 2. POS
      const existingPos = b.productSubscriptions.find(
        (s) => s.productType === BusinessProductType.POS,
      );

      if (!existingPos) {
        const isPosActive = b.hasPOS === true;
        await prisma.businessProductSubscription.create({
          data: {
            businessId: b.id,
            productType: BusinessProductType.POS,
            status: isPosActive ? BusinessProductStatus.ACTIVE : BusinessProductStatus.INACTIVE,
            posVertical: b.posVertical,
            posMonthlyFee: null,
            activatedAt: isPosActive ? b.createdAt : null,
            activatedBy: isPosActive ? 'system-migration' : null,
          },
        });

        if (isPosActive) {
          await prisma.businessProductAuditLog.create({
            data: {
              businessId: b.id,
              productType: BusinessProductType.POS,
              action: BusinessProductAction.ACTIVATED,
              performedBy: 'system-migration',
              reason: 'Backfill inicial por migración a productos independientes (hasPOS activo)',
              metadata: {
                posVertical: b.posVertical,
              },
            },
          });
        }
        posCreated++;
      } else {
        skipped++;
      }
    }

    console.log(`\n✓ Migración completada exitosamente:`);
    console.log(`  - Suscripciones DELIVERY creadas: ${deliveryCreated}`);
    console.log(`  - Suscripciones POS creadas: ${posCreated}`);
    console.log(`  - Negocios ya configurados previamente: ${skipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

backfill().catch((err) => {
  console.error('❌ Error en migración / backfill:', err);
  process.exit(1);
});
