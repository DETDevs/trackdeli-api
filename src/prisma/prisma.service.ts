import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();

    // @ts-ignore
    this.$on('query', (e: any) => {
      if (e.duration > 500) {
        this.logger.warn(`Query lenta (${e.duration}ms): ${e.query}`);
      }
    });

    // @ts-ignore
    this.$on('error', (e: any) => {
      this.logger.error(`Prisma Error: ${e.message}`);
    });

    await this.ensureSchemaSynced();
  }

  private async ensureSchemaSynced() {
    try {
      this.logger.log('[PrismaService] Verificando y sincronizando esquema de base de datos...');

      const ddlStatements = [
        `DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BusinessType') THEN
            CREATE TYPE "BusinessType" AS ENUM ('NEGOCIO', 'EMPRESA_RIDERS');
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DispatchStatus') THEN
            CREATE TYPE "DispatchStatus" AS ENUM ('SENT', 'ACCEPTED', 'REJECTED', 'TIMEOUT');
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CommissionStatus') THEN
            CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'INCLUDED', 'PAID');
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StatementStatus') THEN
            CREATE TYPE "StatementStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE');
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'OFERTADO' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'OrderStatus')) THEN
            ALTER TYPE "OrderStatus" ADD VALUE 'OFERTADO';
          END IF;
        END $$;`,

        `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "businessType" "BusinessType" NOT NULL DEFAULT 'NEGOCIO';`,
        `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.15;`,
        `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "altCommissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.12;`,
        `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "altCommissionDistanceKm" DOUBLE PRECISION NOT NULL DEFAULT 40;`,
        `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "dispatchTimeoutMin" INTEGER NOT NULL DEFAULT 3;`,

        `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "originBusinessName" VARCHAR(150);`,
        `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "originBusinessClientId" TEXT;`,

        `CREATE TABLE IF NOT EXISTS "business_clients" (
          "id" TEXT NOT NULL,
          "businessId" TEXT NOT NULL,
          "name" VARCHAR(150) NOT NULL,
          "phone" VARCHAR(30),
          "address" VARCHAR(300),
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "business_clients_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "business_clients_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
        );`,

        `ALTER TABLE "business_clients" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;`,
        `ALTER TABLE "business_clients" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;`,


        `CREATE TABLE IF NOT EXISTS "monthly_statements" (
          "id" TEXT NOT NULL,
          "businessId" TEXT NOT NULL,
          "month" INTEGER NOT NULL,
          "year" INTEGER NOT NULL,
          "totalDeliveries" INTEGER NOT NULL,
          "totalDeliveryFee" DOUBLE PRECISION NOT NULL,
          "totalCommission" DOUBLE PRECISION NOT NULL,
          "status" "StatementStatus" NOT NULL DEFAULT 'PENDING',
          "dueDate" TIMESTAMP(3) NOT NULL,
          "paidAt" TIMESTAMP(3),
          "paidAmount" DOUBLE PRECISION,
          "notes" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "monthly_statements_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "monthly_statements_businessId_month_year_key" UNIQUE ("businessId", "month", "year"),
          CONSTRAINT "monthly_statements_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
        );`,

        `CREATE TABLE IF NOT EXISTS "order_commissions" (
          "id" TEXT NOT NULL,
          "orderId" TEXT NOT NULL,
          "businessId" TEXT NOT NULL,
          "deliveryFee" DOUBLE PRECISION NOT NULL,
          "distanceKm" DOUBLE PRECISION NOT NULL,
          "commissionRate" DOUBLE PRECISION NOT NULL,
          "commissionAmount" DOUBLE PRECISION NOT NULL,
          "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
          "statementId" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "order_commissions_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "order_commissions_orderId_key" UNIQUE ("orderId"),
          CONSTRAINT "order_commissions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
          CONSTRAINT "order_commissions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
          CONSTRAINT "order_commissions_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "monthly_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE
        );`,

        `CREATE TABLE IF NOT EXISTS "order_dispatches" (
          "id" TEXT NOT NULL,
          "orderId" TEXT NOT NULL,
          "riderId" TEXT NOT NULL,
          "attempt" INTEGER NOT NULL,
          "status" "DispatchStatus" NOT NULL DEFAULT 'SENT',
          "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "respondedAt" TIMESTAMP(3),
          "timeoutAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "order_dispatches_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "order_dispatches_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
          CONSTRAINT "order_dispatches_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
        );`,

        `CREATE INDEX IF NOT EXISTS "order_dispatches_orderId_attempt_idx" ON "order_dispatches"("orderId", "attempt");`,

        `CREATE TABLE IF NOT EXISTS "invite_codes" (
          "id" TEXT NOT NULL,
          "businessId" TEXT NOT NULL,
          "code" VARCHAR(50) NOT NULL,
          "description" VARCHAR(100),
          "maxUses" INTEGER,
          "usedCount" INTEGER NOT NULL DEFAULT 0,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "expiresAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "invite_codes_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "invite_codes_code_key" UNIQUE ("code"),
          CONSTRAINT "invite_codes_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
        );`,

        `CREATE TABLE IF NOT EXISTS "invite_code_usages" (
          "id" TEXT NOT NULL,
          "inviteCodeId" TEXT NOT NULL,
          "riderId" TEXT NOT NULL,
          "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "invite_code_usages_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "invite_code_usages_riderId_key" UNIQUE ("riderId"),
          CONSTRAINT "invite_code_usages_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "invite_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
          CONSTRAINT "invite_code_usages_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
        );`,

        `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "customerLocationMaxDays" INTEGER NOT NULL DEFAULT 30;`,

        `CREATE TABLE IF NOT EXISTS "customers" (
          "id" TEXT NOT NULL,
          "businessId" TEXT NOT NULL,
          "phone" VARCHAR(30) NOT NULL,
          "name" VARCHAR(100) NOT NULL,
          "lastLatitude" DOUBLE PRECISION,
          "lastLongitude" DOUBLE PRECISION,
          "lastAddressText" VARCHAR(300),
          "lastConfirmedAt" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "customers_businessId_phone_key" UNIQUE ("businessId", "phone"),
          CONSTRAINT "customers_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
        );`,

        `CREATE INDEX IF NOT EXISTS "customers_businessId_phone_idx" ON "customers"("businessId", "phone");`,
        `CREATE INDEX IF NOT EXISTS "customers_businessId_name_idx" ON "customers"("businessId", "name");`,

        `CREATE TABLE IF NOT EXISTS "customer_location_sessions" (
          "id" TEXT NOT NULL,
          "customerId" TEXT NOT NULL,
          "token" VARCHAR(64) NOT NULL,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          "respondedAt" TIMESTAMP(3),
          "expiresAt" TIMESTAMP(3) NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "customer_location_sessions_pkey" PRIMARY KEY ("id"),
          CONSTRAINT "customer_location_sessions_token_key" UNIQUE ("token"),
          CONSTRAINT "customer_location_sessions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );`,

        `ALTER TABLE "customer_location_sessions" ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING';`,
        `ALTER TABLE "customer_location_sessions" ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3);`
      ];

      for (const sql of ddlStatements) {
        await this.$executeRawUnsafe(sql);
      }

      this.logger.log('[PrismaService] Esquema de base de datos verificado y listo.');
    } catch (err: any) {
      this.logger.warn(`[PrismaService] Advertencia en auto-sincronización de esquema: ${err.message}`);
    }
  }
}
