const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  try {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "taxConfiguredAt" TIMESTAMP(3);
        ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "taxEnabled" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0;
        ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "taxEnabled" BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
      END $$;
    `);
    console.log('Columns added successfully');
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}
run();
