const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION prevent_pos_audit_log_modification()
    RETURNS TRIGGER AS $$
    BEGIN
        RAISE EXCEPTION 'Updates and Deletes are not allowed on pos_audit_logs';
    END;
    $$ LANGUAGE plpgsql;
  `);

  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS trg_prevent_pos_audit_log_modification ON pos_audit_logs;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER trg_prevent_pos_audit_log_modification
    BEFORE UPDATE OR DELETE ON pos_audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_pos_audit_log_modification();
  `);
  console.log('Trigger created successfully');
}
main().finally(() => prisma.$disconnect());
