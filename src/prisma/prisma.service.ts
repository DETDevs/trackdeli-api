import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  PrismaClient,
  BusinessProductType,
  BusinessProductStatus,
  BusinessProductAction,
  PosVertical,
} from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    let dbUrl = process.env.DATABASE_URL;
    if (dbUrl && !dbUrl.includes('connection_limit')) {
      const sep = dbUrl.includes('?') ? '&' : '?';
      dbUrl = `${dbUrl}${sep}connection_limit=25&pool_timeout=10`;
    }

    super({
      datasources: dbUrl ? { db: { url: dbUrl } } : undefined,
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

    (this as any).$on('query', (e: any) => {
      if (e.duration > 500) {
        this.logger.warn(`Query lenta (${e.duration}ms): ${e.query}`);
      }
    });

    (this as any).$on('error', (e: any) => {
      this.logger.error(`Prisma Error: ${e.message}`);
    });

    await this.ensureSchemaSynced();
  }

  private async ensureSchemaSynced() {
    try {
      this.logger.log('[PrismaService] Verificando y sincronizando esquema de base de datos...');

      const ddlStatements: { name: string; sql: string }[] = [

        {
          name: 'Enums base (BusinessType, DispatchStatus, CommissionStatus, StatementStatus, OrderStatus.OFERTADO)',
          sql: `DO $$ BEGIN
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
        },

        {
          name: 'Columna businesses.businessType',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "businessType" "BusinessType" NOT NULL DEFAULT 'NEGOCIO';`,
        },
        {
          name: 'Columna businesses.commissionRate',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.15;`,
        },
        {
          name: 'Columna businesses.altCommissionRate',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "altCommissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.12;`,
        },
        {
          name: 'Columna businesses.altCommissionDistanceKm',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "altCommissionDistanceKm" DOUBLE PRECISION NOT NULL DEFAULT 40;`,
        },
        {
          name: 'Columna businesses.dispatchTimeoutMin',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "dispatchTimeoutMin" INTEGER NOT NULL DEFAULT 3;`,
        },
        {
          name: 'Columna businesses.customerLocationMaxDays',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "customerLocationMaxDays" INTEGER NOT NULL DEFAULT 30;`,
        },

        {
          name: 'Columna orders.originBusinessName',
          sql: `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "originBusinessName" VARCHAR(150);`,
        },
        {
          name: 'Columna orders.originBusinessClientId',
          sql: `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "originBusinessClientId" TEXT;`,
        },

        {
          name: 'Tabla business_clients',
          sql: `CREATE TABLE IF NOT EXISTS "business_clients" (
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
        },
        {
          name: 'Columna business_clients.latitude',
          sql: `ALTER TABLE "business_clients" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;`,
        },
        {
          name: 'Columna business_clients.longitude',
          sql: `ALTER TABLE "business_clients" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;`,
        },

        {
          name: 'Tabla monthly_statements',
          sql: `CREATE TABLE IF NOT EXISTS "monthly_statements" (
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
        },

        {
          name: 'Tabla order_commissions',
          sql: `CREATE TABLE IF NOT EXISTS "order_commissions" (
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
        },

        {
          name: 'Tabla order_dispatches',
          sql: `CREATE TABLE IF NOT EXISTS "order_dispatches" (
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
        },
        {
          name: 'Índice order_dispatches.orderId_attempt',
          sql: `CREATE INDEX IF NOT EXISTS "order_dispatches_orderId_attempt_idx" ON "order_dispatches"("orderId", "attempt");`,
        },

        {
          name: 'Tabla invite_codes',
          sql: `CREATE TABLE IF NOT EXISTS "invite_codes" (
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
        },
        {
          name: 'Tabla invite_code_usages',
          sql: `CREATE TABLE IF NOT EXISTS "invite_code_usages" (
            "id" TEXT NOT NULL,
            "inviteCodeId" TEXT NOT NULL,
            "riderId" TEXT NOT NULL,
            "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "invite_code_usages_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "invite_code_usages_riderId_key" UNIQUE ("riderId"),
            CONSTRAINT "invite_code_usages_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "invite_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "invite_code_usages_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`,
        },

        {
          name: 'Tabla customers',
          sql: `CREATE TABLE IF NOT EXISTS "customers" (
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
        },
        {
          name: 'Índice customers.businessId_phone',
          sql: `CREATE INDEX IF NOT EXISTS "customers_businessId_phone_idx" ON "customers"("businessId", "phone");`,
        },
        {
          name: 'Índice customers.businessId_name',
          sql: `CREATE INDEX IF NOT EXISTS "customers_businessId_name_idx" ON "customers"("businessId", "name");`,
        },
        {
          name: 'Tabla customer_location_sessions',
          sql: `CREATE TABLE IF NOT EXISTS "customer_location_sessions" (
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
        },
        {
          name: 'Columna customer_location_sessions.status',
          sql: `ALTER TABLE "customer_location_sessions" ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING';`,
        },
        {
          name: 'Columna customer_location_sessions.respondedAt',
          sql: `ALTER TABLE "customer_location_sessions" ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3);`,
        },

        {
          name: 'Enums POS y Subscripciones (PosVertical, TableShape, TableOrderStatus, BusinessProductType, BusinessProductStatus, BusinessProductAction)',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PosVertical') THEN
              CREATE TYPE "PosVertical" AS ENUM ('RETAIL', 'RESTAURANTE');
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TableShape') THEN
              CREATE TYPE "TableShape" AS ENUM ('ROUND', 'SQUARE');
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TableOrderStatus') THEN
              CREATE TYPE "TableOrderStatus" AS ENUM ('OPEN', 'CLOSED');
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BusinessProductType') THEN
              CREATE TYPE "BusinessProductType" AS ENUM ('DELIVERY', 'POS');
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BusinessProductStatus') THEN
              CREATE TYPE "BusinessProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BusinessProductAction') THEN
              CREATE TYPE "BusinessProductAction" AS ENUM ('ACTIVATED', 'DEACTIVATED', 'DEACTIVATION_BLOCKED', 'DEACTIVATION_FORCED', 'CONFIG_UPDATED');
            END IF;
          END $$;`,
        },

        {
          name: 'Columna businesses.posVertical',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "posVertical" "PosVertical" NOT NULL DEFAULT 'RETAIL';`,
        },
        {
          name: 'Columna businesses.gridColumns',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "gridColumns" INTEGER NOT NULL DEFAULT 10;`,
        },
        {
          name: 'Columna businesses.gridRows',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "gridRows" INTEGER NOT NULL DEFAULT 10;`,
        },
        {
          name: 'Columna businesses.posAddress',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "posAddress" VARCHAR(300);`,
        },
        {
          name: 'Columna businesses.posPhone',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "posPhone" VARCHAR(30);`,
        },
        {
          name: 'Columna businesses.posFooter',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "posFooter" VARCHAR(200);`,
        },

        {
          name: 'Tabla pos_restaurant_tables',
          sql: `CREATE TABLE IF NOT EXISTS "pos_restaurant_tables" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "number" VARCHAR(50) NOT NULL,
            "capacity" INTEGER NOT NULL DEFAULT 4,
            "shape" "TableShape" NOT NULL DEFAULT 'SQUARE',
            "gridX" INTEGER NOT NULL,
            "gridY" INTEGER NOT NULL,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_restaurant_tables_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_restaurant_tables_businessId_number_key" UNIQUE ("businessId", "number"),
            CONSTRAINT "pos_restaurant_tables_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice pos_restaurant_tables.businessId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_restaurant_tables_businessId_idx" ON "pos_restaurant_tables"("businessId");`,
        },
        {
          name: 'Tabla pos_table_orders',
          sql: `CREATE TABLE IF NOT EXISTS "pos_table_orders" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "tableId" TEXT NOT NULL,
            "status" "TableOrderStatus" NOT NULL DEFAULT 'OPEN',
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "closedAt" TIMESTAMP(3),
            "saleId" TEXT,
            "notes" TEXT,
            CONSTRAINT "pos_table_orders_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_table_orders_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_table_orders_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "pos_restaurant_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice pos_table_orders.businessId_status',
          sql: `CREATE INDEX IF NOT EXISTS "pos_table_orders_businessId_status_idx" ON "pos_table_orders"("businessId", "status");`,
        },
        {
          name: 'Índice pos_table_orders.tableId_status',
          sql: `CREATE INDEX IF NOT EXISTS "pos_table_orders_tableId_status_idx" ON "pos_table_orders"("tableId", "status");`,
        },
        {
          name: 'Tabla pos_table_order_items',
          sql: `CREATE TABLE IF NOT EXISTS "pos_table_order_items" (
            "id" TEXT NOT NULL,
            "tableOrderId" TEXT NOT NULL,
            "productId" TEXT NOT NULL,
            "productName" VARCHAR(200) NOT NULL,
            "quantity" INTEGER NOT NULL,
            "unitPrice" DOUBLE PRECISION NOT NULL,
            "notes" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_table_order_items_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_table_order_items_tableOrderId_fkey" FOREIGN KEY ("tableOrderId") REFERENCES "pos_table_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_table_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "pos_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`,
        },

        {
          name: 'Tabla business_product_subscriptions',
          sql: `CREATE TABLE IF NOT EXISTS "business_product_subscriptions" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "productType" "BusinessProductType" NOT NULL,
            "status" "BusinessProductStatus" NOT NULL DEFAULT 'INACTIVE',
            "commissionRate" DECIMAL(10, 4),
            "altCommissionRate" DECIMAL(10, 4),
            "altCommissionDistanceKm" DECIMAL(10, 2),
            "dispatchTimeoutMin" INTEGER,
            "posVertical" "PosVertical",
            "posMonthlyFee" DECIMAL(10, 2),
            "activatedAt" TIMESTAMP(3),
            "activatedBy" TEXT,
            "deactivatedAt" TIMESTAMP(3),
            "deactivatedBy" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "business_product_subscriptions_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "business_product_subscriptions_businessId_productType_key" UNIQUE ("businessId", "productType"),
            CONSTRAINT "business_product_subscriptions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice business_product_subscriptions.businessId',
          sql: `CREATE INDEX IF NOT EXISTS "business_product_subscriptions_businessId_idx" ON "business_product_subscriptions"("businessId");`,
        },
        {
          name: 'Tabla business_product_audit_logs',
          sql: `CREATE TABLE IF NOT EXISTS "business_product_audit_logs" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "productType" "BusinessProductType" NOT NULL,
            "action" "BusinessProductAction" NOT NULL,
            "performedBy" TEXT NOT NULL,
            "reason" TEXT,
            "metadata" JSONB,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "business_product_audit_logs_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "business_product_audit_logs_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice business_product_audit_logs.businessId_productType',
          sql: `CREATE INDEX IF NOT EXISTS "business_product_audit_logs_businessId_productType_idx" ON "business_product_audit_logs"("businessId", "productType");`,
        },

        {
          name: 'Columna pos_products.trackStock',
          sql: `ALTER TABLE "pos_products" ADD COLUMN IF NOT EXISTS "trackStock" BOOLEAN NOT NULL DEFAULT true;`,
        },

        {
          name: 'Tabla pos_terminals',
          sql: `CREATE TABLE IF NOT EXISTS "pos_terminals" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "deviceIdentifier" VARCHAR(100) NOT NULL,
            "name" VARCHAR(100) NOT NULL,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "hasPendingOfflineSales" BOOLEAN NOT NULL DEFAULT false,
            "pendingSalesCount" INTEGER NOT NULL DEFAULT 0,
            "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_terminals_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_terminals_businessId_deviceIdentifier_key" UNIQUE ("businessId", "deviceIdentifier"),
            CONSTRAINT "pos_terminals_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Columna pos_sales.clientGeneratedId',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "clientGeneratedId" VARCHAR(100);`,
        },
        {
          name: 'Columna pos_sales.occurredAt',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3);`,
        },
        {
          name: 'Columna pos_sales.syncedAt',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "syncedAt" TIMESTAMP(3);`,
        },
        {
          name: 'Columna pos_sales.isOffline',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "isOffline" BOOLEAN NOT NULL DEFAULT false;`,
        },
        {
          name: 'Columna pos_sales.posTerminalId',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "posTerminalId" TEXT;`,
        },
        {
          name: 'Índice único pos_sales.clientGeneratedId',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "pos_sales_clientGeneratedId_key" ON "pos_sales"("clientGeneratedId") WHERE "clientGeneratedId" IS NOT NULL;`,
        },
        {
          name: 'Foreign key pos_sales.posTerminalId',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_sales_posTerminalId_fkey') THEN
              ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_posTerminalId_fkey" FOREIGN KEY ("posTerminalId") REFERENCES "pos_terminals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            END IF;
          END $$;`,
        },
        {
          name: 'Tabla pos_inventory_discrepancies',
          sql: `CREATE TABLE IF NOT EXISTS "pos_inventory_discrepancies" (
            "id" TEXT NOT NULL,
            "productId" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "saleId" TEXT NOT NULL,
            "expectedStock" INTEGER NOT NULL,
            "resultingStock" INTEGER NOT NULL,
            "resolved" BOOLEAN NOT NULL DEFAULT false,
            "resolvedAt" TIMESTAMP(3),
            "resolvedBy" TEXT,
            "notes" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_inventory_discrepancies_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_inventory_discrepancies_productId_fkey" FOREIGN KEY ("productId") REFERENCES "pos_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "pos_inventory_discrepancies_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_inventory_discrepancies_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "pos_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice pos_inventory_discrepancies.businessId_resolved',
          sql: `CREATE INDEX IF NOT EXISTS "pos_inventory_discrepancies_businessId_resolved_idx" ON "pos_inventory_discrepancies"("businessId", "resolved");`,
        },
      ];

      for (const step of ddlStatements) {
        try {
          await this.$executeRawUnsafe(step.sql);
          this.logger.log(`[PrismaService] ✓ Sincronizado: ${step.name}`);
        } catch (stepErr: any) {
          this.logger.warn(`[PrismaService] ⚠ Advertencia en ${step.name}: ${stepErr.message}`);
        }
      }

      this.logger.log('[PrismaService] Esquema de base de datos verificado y listo.');

      await this.ensureBusinessProductsBackfilled();

      await this.reconcileProductTrackStock();
    } catch (err: any) {
      this.logger.warn(`[PrismaService] Advertencia general en auto-sincronización de esquema: ${err.message}`);
    }
  }

  private async ensureBusinessProductsBackfilled() {
    try {
      this.logger.log('[PrismaService] Verificando backfill de BusinessProductSubscription...');
      const businesses = await this.business.findMany({
        include: {
          productSubscriptions: true,
        },
      });

      let deliveryCreated = 0;
      let posCreated = 0;
      let skipped = 0;

      for (const b of businesses) {

        const existingDelivery = b.productSubscriptions.find(
          (s) => s.productType === BusinessProductType.DELIVERY,
        );

        if (!existingDelivery) {
          await this.businessProductSubscription.create({
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

          await this.businessProductAuditLog.create({
            data: {
              businessId: b.id,
              productType: BusinessProductType.DELIVERY,
              action: BusinessProductAction.ACTIVATED,
              performedBy: 'system-migration',
              reason: 'Backfill inicial automático por migración a productos independientes',
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

        const existingPos = b.productSubscriptions.find(
          (s) => s.productType === BusinessProductType.POS,
        );

        if (!existingPos) {
          const isPosActive = b.hasPOS === true;
          await this.businessProductSubscription.create({
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
            await this.businessProductAuditLog.create({
              data: {
                businessId: b.id,
                productType: BusinessProductType.POS,
                action: BusinessProductAction.ACTIVATED,
                performedBy: 'system-migration',
                reason: 'Backfill inicial automático por migración a productos independientes (hasPOS activo)',
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

      if (deliveryCreated > 0 || posCreated > 0) {
        this.logger.log(
          `[PrismaService] ✓ Backfill completado: ${deliveryCreated} suscripciones DELIVERY creadas, ${posCreated} POS creadas (${skipped} ya existían).`,
        );
      } else {
        this.logger.log('[PrismaService] ✓ Suscripciones de productos ya estaban sincronizadas para todos los negocios.');
      }

      await this.reconcilePosVertical(businesses);
    } catch (backfillErr: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en backfill automático de productos: ${backfillErr.message}`);
    }
  }

  private async reconcilePosVertical(businesses: any[]) {
    try {
      let reconciled = 0;
      for (const b of businesses) {

        if (!b.posVertical || b.posVertical === 'RETAIL') continue;

        const posSub = b.productSubscriptions.find(
          (s: any) => s.productType === BusinessProductType.POS,
        );

        if (posSub && posSub.posVertical === b.posVertical) continue;

        const previousValue = posSub?.posVertical ?? null;

        await this.businessProductSubscription.updateMany({
          where: { businessId: b.id, productType: BusinessProductType.POS },
          data: { posVertical: b.posVertical },
        });

        this.logger.log(
          `[PrismaService] ✓ posVertical reconciliado: negocio="${b.name}" (${b.id}) ` +
          `suscripción: ${previousValue ?? 'null'} → ${b.posVertical}`,
        );
        reconciled++;
      }

      if (reconciled === 0) {
        this.logger.log('[PrismaService] ✓ posVertical ya sincronizado en todas las suscripciones POS.');
      } else {
        this.logger.log(`[PrismaService] ✓ posVertical reconciliado en ${reconciled} negocio(s).`);
      }
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en reconciliación de posVertical: ${err.message}`);
    }
  }

  private async reconcileProductTrackStock() {
    try {
      this.logger.log('[PrismaService] Verificando backfill de trackStock para productos...');
      const businesses = await this.business.findMany({
        select: {
          id: true,
          name: true,
          posVertical: true,
          productSubscriptions: {
            where: { productType: BusinessProductType.POS },
            select: { posVertical: true },
          },
        },
      });

      let updatedCount = 0;

      for (const b of businesses) {
        const vertical = b.productSubscriptions[0]?.posVertical || b.posVertical || PosVertical.RETAIL;

        if (vertical === PosVertical.RESTAURANTE) {

          const res = await this.product.updateMany({
            where: {
              businessId: b.id,
              stock: { lte: 0 },
              trackStock: true,
            },
            data: {
              trackStock: false,
            },
          });
          if (res.count > 0) {
            this.logger.log(
              `[PrismaService] ✓ Actualizados ${res.count} producto(s) a trackStock=false para el restaurante "${b.name}" (${b.id})`,
            );
            updatedCount += res.count;
          }
        }
      }

      if (updatedCount === 0) {
        this.logger.log('[PrismaService] ✓ trackStock ya sincronizado para todos los productos.');
      } else {
        this.logger.log(`[PrismaService] ✓ Backfill de trackStock completado: ${updatedCount} producto(s) actualizados.`);
      }
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en backfill de trackStock: ${err.message}`);
    }
  }
}

