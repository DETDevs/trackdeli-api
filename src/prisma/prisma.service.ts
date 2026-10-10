import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  PrismaClient,
  BusinessProductType,
  BusinessProductStatus,
  BusinessProductAction,
  PosVertical,
  BusinessType,
  ProductFieldDataType,
  Prisma,
} from '@prisma/client';
import { slugify } from '../common/utils/slug.util';
import { traceContext } from '../common/trace-context';

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
    (Prisma.Decimal.prototype as any).toJSON = function () {
      return this.toNumber();
    };
    await this.$connect();

    (this as any).$on('query', (e: any) => {
      const trace = traceContext.getStore();
      if (trace) {
        trace.queryCount++;
        trace.queryTimeMs += e.duration;
      }

      if (e.duration > 200 && process.env.TRACE_ENABLED === 'true') {
        const shortQuery = e.query.length > 200 ? e.query.substring(0, 200) + '...' : e.query;
        this.logger.warn(`[SLOW QUERY] (${e.duration}ms): ${shortQuery}`);
      } else if (e.duration > 500) {
        // Fallback original behavior if trace not enabled
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
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AuthProvider') THEN
              CREATE TYPE "AuthProvider" AS ENUM ('EMAIL', 'GOOGLE', 'APPLE');
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'OFERTADO' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'OrderStatus' LIMIT 1)) THEN
              ALTER TYPE "OrderStatus" ADD VALUE 'OFERTADO';
            END IF;
          END $$;`,
        },

        {
          name: 'Tabla pos_policies',
          sql: `CREATE TABLE IF NOT EXISTS "pos_policies" (
            "businessId" TEXT NOT NULL,
            "returnsEnabled" BOOLEAN NOT NULL DEFAULT true,
            "returnsRequireApproval" BOOLEAN NOT NULL DEFAULT true,
            "returnsMaxDays" INTEGER NOT NULL DEFAULT 30,
            "voidsCompletedEnabled" BOOLEAN NOT NULL DEFAULT true,
            "voidsRequireApproval" BOOLEAN NOT NULL DEFAULT true,
            "discountsEnabled" BOOLEAN NOT NULL DEFAULT true,
            "cashierMaxDiscountPercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
            "priceOverrideEnabled" BOOLEAN NOT NULL DEFAULT false,
            "paymentMethodsEnabled" TEXT NOT NULL DEFAULT 'EFECTIVO,TARJETA,TRANSFERENCIA,CREDITO,OTRO',
            "requireReferenceCard" BOOLEAN NOT NULL DEFAULT true,
            "requireReferenceTransfer" BOOLEAN NOT NULL DEFAULT true,
            "requireReferenceOther" BOOLEAN NOT NULL DEFAULT false,
            "multiCurrencyEnabled" BOOLEAN NOT NULL DEFAULT false,
            "acceptedCurrencies" TEXT NOT NULL DEFAULT 'NIO',
            "blindCashClose" BOOLEAN NOT NULL DEFAULT true,
            "cashDifferenceTolerance" DOUBLE PRECISION NOT NULL DEFAULT 0,
            "noSaleDrawerOpenAllowed" BOOLEAN NOT NULL DEFAULT true,
            "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false,
            "inventoryAdjustRequireApproval" BOOLEAN NOT NULL DEFAULT true,
            CONSTRAINT "pos_policies_pkey" PRIMARY KEY ("businessId"),
            CONSTRAINT "pos_policies_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Tabla pos_audit_logs',
          sql: `CREATE TABLE IF NOT EXISTS "pos_audit_logs" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "userRole" TEXT NOT NULL,
            "action" VARCHAR(100) NOT NULL,
            "entityType" VARCHAR(100),
            "entityId" VARCHAR(100),
            "before" JSONB,
            "after" JSONB,
            "reason" VARCHAR(500),
            "terminalId" VARCHAR(100),
            "ipAddress" VARCHAR(100),
            "approvedById" VARCHAR(100),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_audit_logs_pkey" PRIMARY KEY ("id")
          );`
        },
        {
          name: 'Indices pos_audit_logs',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_audit_logs_businessId_createdAt_idx') THEN
              CREATE INDEX "pos_audit_logs_businessId_createdAt_idx" ON "pos_audit_logs"("businessId", "createdAt");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_audit_logs_userId_idx') THEN
              CREATE INDEX "pos_audit_logs_userId_idx" ON "pos_audit_logs"("userId");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_audit_logs_action_idx') THEN
              CREATE INDEX "pos_audit_logs_action_idx" ON "pos_audit_logs"("action");
            END IF;
          END $$;`
        },
        {
          name: 'Funcion inmutabilidad pos_audit_logs',
          sql: `
            CREATE OR REPLACE FUNCTION prevent_pos_audit_log_modification()
            RETURNS TRIGGER AS $$
            BEGIN
              RAISE EXCEPTION 'Updates and Deletes are not allowed on pos_audit_logs';
            END;
            $$ LANGUAGE plpgsql;
          `,
        },
        {
          name: 'Trigger inmutabilidad pos_audit_logs',
          sql: `
            DO $$ BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_pos_audit_log_modification'
              ) THEN
                CREATE TRIGGER trg_prevent_pos_audit_log_modification
                BEFORE UPDATE OR DELETE ON pos_audit_logs
                FOR EACH ROW
                EXECUTE FUNCTION prevent_pos_audit_log_modification();
              END IF;
            END $$;
          `,
        },
        {
          name: 'Tabla pos_approval_tokens',
          sql: `CREATE TABLE IF NOT EXISTS "pos_approval_tokens" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "token" VARCHAR(100) NOT NULL,
            "action" VARCHAR(100) NOT NULL,
            "entityType" VARCHAR(100),
            "entityId" VARCHAR(100),
            "approvedById" TEXT NOT NULL,
            "terminalId" VARCHAR(100),
            "isUsed" BOOLEAN NOT NULL DEFAULT false,
            "expiresAt" TIMESTAMP(3) NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_approval_tokens_pkey" PRIMARY KEY ("id")
          );`
        },
        {
          name: 'Indices pos_approval_tokens',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_approval_tokens_token_key') THEN
              CREATE UNIQUE INDEX "pos_approval_tokens_token_key" ON "pos_approval_tokens"("token");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_approval_tokens_businessId_token_idx') THEN
              CREATE INDEX "pos_approval_tokens_businessId_token_idx" ON "pos_approval_tokens"("businessId", "token");
            END IF;
          END $$;`
        },
        {
          name: 'Tabla idempotency_keys',
          sql: `CREATE TABLE IF NOT EXISTS "idempotency_keys" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "key" VARCHAR(100) NOT NULL,
            "requestHash" VARCHAR(100) NOT NULL,
            "responseBody" JSONB,
            "statusCode" INTEGER NOT NULL,
            "expiresAt" TIMESTAMP(3) NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
          );`
        },
        {
          name: 'Indices idempotency_keys',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idempotency_keys_businessId_key_key') THEN
              CREATE UNIQUE INDEX "idempotency_keys_businessId_key_key" ON "idempotency_keys"("businessId", "key");
            END IF;
          END $$;`
        },
        {
          name: 'Tabla pos_payments',
          sql: `CREATE TABLE IF NOT EXISTS "pos_payments" (
            "id" TEXT NOT NULL,
            "saleId" TEXT NOT NULL,
            "method" VARCHAR(50) NOT NULL,
            "amount" DOUBLE PRECISION NOT NULL,
            "amountTendered" DOUBLE PRECISION,
            "change" DOUBLE PRECISION NOT NULL DEFAULT 0,
            "reference" VARCHAR(100),
            "currency" VARCHAR(10) NOT NULL DEFAULT 'NIO',
            "exchangeRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
            "amountBase" DOUBLE PRECISION NOT NULL,
            "shiftId" TEXT,
            "createdById" TEXT NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_payments_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_payments_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "pos_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "pos_cash_registers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
            CONSTRAINT "pos_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`
        },
        {
          name: 'Indices pos_payments',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_payments_saleId_idx') THEN
              CREATE INDEX "pos_payments_saleId_idx" ON "pos_payments"("saleId");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_payments_shiftId_idx') THEN
              CREATE INDEX "pos_payments_shiftId_idx" ON "pos_payments"("shiftId");
            END IF;
          END $$;`
        },
        {
          name: 'Tabla pos_exchange_rates',
          sql: `CREATE TABLE IF NOT EXISTS "pos_exchange_rates" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "base" VARCHAR(10) NOT NULL DEFAULT 'NIO',
            "quote" VARCHAR(10) NOT NULL DEFAULT 'USD',
            "rate" NUMERIC(10,4) NOT NULL,
            "source" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
            "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "setById" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_exchange_rates_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_exchange_rates_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_exchange_rates_setById_fkey" FOREIGN KEY ("setById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
          )`
        },
        {
          name: 'Indices pos_exchange_rates',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_exchange_rates_businessId_quote_effectiveFrom_idx') THEN
              CREATE INDEX "pos_exchange_rates_businessId_quote_effectiveFrom_idx" ON "pos_exchange_rates"("businessId", "quote", "effectiveFrom");
            END IF;
          END $$;`
        },
        {
          name: 'Columnas 113c en cash registers y movements',
          sql: `DO $$ BEGIN
            ALTER TABLE "pos_cash_registers" ADD COLUMN IF NOT EXISTS "expectedCashUsd" NUMERIC(12,2);
            ALTER TABLE "pos_cash_registers" ADD COLUMN IF NOT EXISTS "closingCashUsd" NUMERIC(12,2);
            ALTER TABLE "pos_cash_registers" ADD COLUMN IF NOT EXISTS "differenceUsd" NUMERIC(12,2);
            ALTER TABLE "pos_cash_registers" ADD COLUMN IF NOT EXISTS "totalCashUsd" NUMERIC(12,2);

            ALTER TABLE "pos_cash_movements" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10) NOT NULL DEFAULT 'NIO';
            ALTER TABLE "pos_cash_movements" ADD COLUMN IF NOT EXISTS "exchangeRate" NUMERIC(10,4) NOT NULL DEFAULT 1;
            ALTER TABLE "pos_cash_movements" ADD COLUMN IF NOT EXISTS "amountBase" NUMERIC(12,2) NOT NULL DEFAULT 0;

            ALTER TABLE "pos_payments" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10) NOT NULL DEFAULT 'NIO';
            ALTER TABLE "pos_payments" ADD COLUMN IF NOT EXISTS "exchangeRate" NUMERIC(10,4) NOT NULL DEFAULT 1;
            ALTER TABLE "pos_payments" ADD COLUMN IF NOT EXISTS "amountBase" NUMERIC(12,2) NOT NULL DEFAULT 0;
            BEGIN
              ALTER TABLE "pos_payments" ALTER COLUMN "exchangeRate" TYPE NUMERIC(10,4);
              ALTER TABLE "pos_payments" ALTER COLUMN "amountBase" TYPE NUMERIC(12,2);
            EXCEPTION WHEN OTHERS THEN
              NULL;
            END;
          END $$;`
        },
        {
          name: '113d - Estados y columnas de anulaciones y devoluciones',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VOIDED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'SaleStatus' LIMIT 1)) THEN
              ALTER TYPE "SaleStatus" ADD VALUE 'VOIDED';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'PARTIALLY_RETURNED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'SaleStatus' LIMIT 1)) THEN
              ALTER TYPE "SaleStatus" ADD VALUE 'PARTIALLY_RETURNED';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'RETURNED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'SaleStatus' LIMIT 1)) THEN
              ALTER TYPE "SaleStatus" ADD VALUE 'RETURNED';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'CANCELLED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'CreditAccountStatus' LIMIT 1)) THEN
              ALTER TYPE "CreditAccountStatus" ADD VALUE 'CANCELLED';
            END IF;

            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "voidedById" TEXT;
            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "voidReason" VARCHAR(500);
            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "voidApprovedById" TEXT;

            ALTER TABLE "pos_sale_items" ADD COLUMN IF NOT EXISTS "returnedQty" DOUBLE PRECISION NOT NULL DEFAULT 0;
          END $$;`
        },
        {
          name: '113d - Tabla pos_sale_returns',
          sql: `CREATE TABLE IF NOT EXISTS "pos_sale_returns" (
            "id" TEXT NOT NULL,
            "saleId" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "returnNumber" VARCHAR(30) NOT NULL,
            "reason" VARCHAR(100) NOT NULL,
            "notes" VARCHAR(500),
            "refundMethod" "PosPaymentMethod" NOT NULL,
            "refundAmount" DOUBLE PRECISION NOT NULL,
            "taxRefunded" DOUBLE PRECISION NOT NULL DEFAULT 0,
            "createdById" TEXT NOT NULL,
            "approvedById" TEXT,
            "shiftId" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_sale_returns_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_sale_returns_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "pos_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_sale_returns_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`
        },
        {
          name: '113d - Indices pos_sale_returns',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_sale_returns_saleId_idx') THEN
              CREATE INDEX "pos_sale_returns_saleId_idx" ON "pos_sale_returns"("saleId");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_sale_returns_businessId_createdAt_idx') THEN
              CREATE INDEX "pos_sale_returns_businessId_createdAt_idx" ON "pos_sale_returns"("businessId", "createdAt");
            END IF;
          END $$;`
        },
        {
          name: '113d - Tabla pos_sale_return_items',
          sql: `CREATE TABLE IF NOT EXISTS "pos_sale_return_items" (
            "id" TEXT NOT NULL,
            "returnId" TEXT NOT NULL,
            "saleItemId" TEXT NOT NULL,
            "productId" TEXT,
            "productName" VARCHAR(200) NOT NULL,
            "quantity" DOUBLE PRECISION NOT NULL,
            "unitPrice" DOUBLE PRECISION NOT NULL,
            "discountProrated" DOUBLE PRECISION NOT NULL DEFAULT 0,
            "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
            "taxIncluded" BOOLEAN NOT NULL DEFAULT false,
            "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
            "refundAmount" DOUBLE PRECISION NOT NULL,
            "restock" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_sale_return_items_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_sale_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "pos_sale_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_sale_return_items_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "pos_sale_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`
        },
        {
          name: '113d - Indices pos_sale_return_items',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_sale_return_items_returnId_idx') THEN
              CREATE INDEX "pos_sale_return_items_returnId_idx" ON "pos_sale_return_items"("returnId");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_sale_return_items_saleItemId_idx') THEN
              CREATE INDEX "pos_sale_return_items_saleItemId_idx" ON "pos_sale_return_items"("saleItemId");
            END IF;
          END $$;`
        },
        {
          name: '113e - Enums y columnas de stock y proveedores',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'INITIAL' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'StockMovementType' LIMIT 1)) THEN
              ALTER TYPE "StockMovementType" ADD VALUE 'INITIAL';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'PURCHASE' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'StockMovementType' LIMIT 1)) THEN
              ALTER TYPE "StockMovementType" ADD VALUE 'PURCHASE';
            END IF;

            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PurchaseStatus') THEN
              CREATE TYPE "PurchaseStatus" AS ENUM ('RECEIVED', 'VOIDED');
            END IF;

            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InventoryAdjustmentType') THEN
              CREATE TYPE "InventoryAdjustmentType" AS ENUM ('COUNT', 'SHRINKAGE', 'DAMAGE', 'EXPIRED', 'THEFT', 'CORRECTION', 'INITIAL');
            END IF;

            ALTER TABLE "pos_suppliers" ADD COLUMN IF NOT EXISTS "taxId" VARCHAR(50);
            ALTER TABLE "pos_suppliers" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "hasNegativeStock" BOOLEAN NOT NULL DEFAULT false;
          END $$;`
        },
        {
          name: '113e - Tabla pos_purchases',
          sql: `CREATE TABLE IF NOT EXISTS "pos_purchases" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "supplierId" TEXT,
            "invoiceNumber" VARCHAR(100),
            "purchaseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "notes" TEXT,
            "status" "PurchaseStatus" NOT NULL DEFAULT 'RECEIVED',
            "total" NUMERIC(12,2) NOT NULL,
            "createdById" TEXT NOT NULL,
            "voidedAt" TIMESTAMP(3),
            "voidedById" TEXT,
            "voidReason" VARCHAR(500),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_purchases_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_purchases_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "pos_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
            CONSTRAINT "pos_purchases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "pos_purchases_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
          );`
        },
        {
          name: '113e - Indices pos_purchases',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_purchases_businessId_purchaseDate_idx') THEN
              CREATE INDEX "pos_purchases_businessId_purchaseDate_idx" ON "pos_purchases"("businessId", "purchaseDate");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_purchases_businessId_supplierId_idx') THEN
              CREATE INDEX "pos_purchases_businessId_supplierId_idx" ON "pos_purchases"("businessId", "supplierId");
            END IF;
          END $$;`
        },
        {
          name: '113e - Tabla pos_purchase_items',
          sql: `CREATE TABLE IF NOT EXISTS "pos_purchase_items" (
            "id" TEXT NOT NULL,
            "purchaseId" TEXT NOT NULL,
            "productId" TEXT NOT NULL,
            "quantity" INTEGER NOT NULL,
            "unitCost" NUMERIC(12,4) NOT NULL,
            "subtotal" NUMERIC(12,2) NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_purchase_items_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_purchase_items_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "pos_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_purchase_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "pos_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`
        },
        {
          name: '113e - Indices pos_purchase_items',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_purchase_items_purchaseId_idx') THEN
              CREATE INDEX "pos_purchase_items_purchaseId_idx" ON "pos_purchase_items"("purchaseId");
            END IF;
          END $$;`
        },
        {
          name: '113e - Tabla pos_product_cost_history',
          sql: `CREATE TABLE IF NOT EXISTS "pos_product_cost_history" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "productId" TEXT NOT NULL,
            "oldCost" NUMERIC(12,4),
            "newCost" NUMERIC(12,4) NOT NULL,
            "purchaseId" TEXT,
            "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "reason" VARCHAR(200),
            CONSTRAINT "pos_product_cost_history_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_product_cost_history_productId_fkey" FOREIGN KEY ("productId") REFERENCES "pos_products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_product_cost_history_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "pos_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE
          );`
        },
        {
          name: '113e - Indices pos_product_cost_history',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_product_cost_history_productId_date_idx') THEN
              CREATE INDEX "pos_product_cost_history_productId_date_idx" ON "pos_product_cost_history"("productId", "date");
            END IF;
          END $$;`
        },
        {
          name: '113e - Tabla pos_inventory_adjustments',
          sql: `CREATE TABLE IF NOT EXISTS "pos_inventory_adjustments" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "productId" TEXT NOT NULL,
            "type" "InventoryAdjustmentType" NOT NULL,
            "qtyDelta" INTEGER NOT NULL,
            "reason" VARCHAR(500) NOT NULL,
            "notes" TEXT,
            "userId" TEXT NOT NULL,
            "approvedById" TEXT,
            "costAtTime" NUMERIC(12,4),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_inventory_adjustments_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_inventory_adjustments_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_inventory_adjustments_productId_fkey" FOREIGN KEY ("productId") REFERENCES "pos_products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_inventory_adjustments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "pos_inventory_adjustments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
          );`
        },
        {
          name: '113e - Indices pos_inventory_adjustments',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_inventory_adjustments_businessId_productId_idx') THEN
              CREATE INDEX "pos_inventory_adjustments_businessId_productId_idx" ON "pos_inventory_adjustments"("businessId", "productId");
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pos_inventory_adjustments_businessId_createdAt_idx') THEN
              CREATE INDEX "pos_inventory_adjustments_businessId_createdAt_idx" ON "pos_inventory_adjustments"("businessId", "createdAt");
            END IF;
          END $$;`
        },
        {
          name: '113f - Conversion de costos a NUMERIC(12,4)',
          sql: `DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_purchase_items' AND column_name = 'unitCost') THEN
              ALTER TABLE "pos_purchase_items" ALTER COLUMN "unitCost" TYPE NUMERIC(12,4);
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_product_cost_history' AND column_name = 'oldCost') THEN
              ALTER TABLE "pos_product_cost_history" ALTER COLUMN "oldCost" TYPE NUMERIC(12,4);
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_product_cost_history' AND column_name = 'newCost') THEN
              ALTER TABLE "pos_product_cost_history" ALTER COLUMN "newCost" TYPE NUMERIC(12,4);
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_inventory_adjustments' AND column_name = 'costAtTime') THEN
              ALTER TABLE "pos_inventory_adjustments" ALTER COLUMN "costAtTime" TYPE NUMERIC(12,4);
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_stock_movements' AND column_name = 'cost') THEN
              ALTER TABLE "pos_stock_movements" ALTER COLUMN "cost" TYPE NUMERIC(12,4);
            END IF;
          END $$;`
        },
        {
          name: '113h - Ajuste de payments amount y default pos_policies.paymentMethodsEnabled',
          sql: `DO $$ BEGIN
            -- 1. Alinear DDL para pos_policies.paymentMethodsEnabled default
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_policies' AND column_name = 'paymentMethodsEnabled') THEN
              ALTER TABLE "pos_policies" ALTER COLUMN "paymentMethodsEnabled" SET DEFAULT 'EFECTIVO,TARJETA,TRANSFERENCIA,CREDITO,OTRO';
            END IF;

            -- 2. Corregir pagos existentes donde suma de amount <> total y el pago en efectivo tiene change > 0
            -- Dejar amount = amount - change (y amountBase = amountBase - change)
            UPDATE pos_payments p
            SET 
              amount = p.amount - p.change,
              "amountBase" = p."amountBase" - p.change
            FROM pos_sales s
            WHERE p."saleId" = s.id
              AND s.status NOT IN ('CANCELLED', 'VOIDED', 'RETURNED')
              AND p.method = 'EFECTIVO'
              AND p.change > 0
              AND p.amount > p.change
              AND (
                SELECT SUM(p2.amount) 
                FROM pos_payments p2 
                WHERE p2."saleId" = s.id
              ) <> s.total;

            -- 3. Para ventas de un solo pago sin change registrado donde amount <> total, amount = total
            UPDATE pos_payments p
            SET 
              amount = s.total,
              "amountBase" = s.total
            FROM pos_sales s
            WHERE p."saleId" = s.id
              AND s.status NOT IN ('CANCELLED', 'VOIDED', 'RETURNED')
              AND (
                SELECT COUNT(*) 
                FROM pos_payments p2 
                WHERE p2."saleId" = s.id
              ) = 1
              AND (p.change IS NULL OR p.change = 0)
              AND p.amount <> s.total;
          END $$;`
        },
        {
          name: '116a - Cuentas de empresa (convenios) en Cartera de Cobro y cortes',
          sql: `DO $$ BEGIN
            -- 1. Tabla de empresas (convenios)
            CREATE TABLE IF NOT EXISTS "pos_credit_groups" (
              "id" TEXT NOT NULL PRIMARY KEY,
              "businessId" TEXT NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
              "name" VARCHAR(150) NOT NULL,
              "taxId" VARCHAR(50),
              "contactName" VARCHAR(150),
              "contactPhone" VARCHAR(50),
              "contactEmail" VARCHAR(255),
              "billingCycle" VARCHAR(30) NOT NULL DEFAULT 'BIWEEKLY',
              "cutDay1" INTEGER,
              "cutDay2" INTEGER,
              "payDayOffset" INTEGER DEFAULT 0,
              "creditLimit" DECIMAL(12, 2),
              "isActive" BOOLEAN NOT NULL DEFAULT true,
              "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
              "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS "pos_credit_groups_businessId_idx" ON "pos_credit_groups"("businessId");
            CREATE INDEX IF NOT EXISTS "pos_credit_groups_businessId_isActive_idx" ON "pos_credit_groups"("businessId", "isActive");

            -- 2. Tabla de cortes congelados
            CREATE TABLE IF NOT EXISTS "pos_credit_statements" (
              "id" TEXT NOT NULL PRIMARY KEY,
              "businessId" TEXT NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
              "groupId" TEXT NOT NULL REFERENCES "pos_credit_groups"("id") ON DELETE RESTRICT,
              "statementNumber" VARCHAR(50),
              "periodFrom" TIMESTAMP(3) NOT NULL,
              "periodTo" TIMESTAMP(3) NOT NULL,
              "cutDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
              "payDueDate" TIMESTAMP(3),
              "status" VARCHAR(30) NOT NULL DEFAULT 'OPEN',
              "totalAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
              "settledAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
              "notes" TEXT,
              "createdById" TEXT NOT NULL,
              "settledById" TEXT,
              "settledAt" TIMESTAMP(3),
              "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
              "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS "pos_credit_statements_businessId_groupId_idx" ON "pos_credit_statements"("businessId", "groupId");
            CREATE INDEX IF NOT EXISTS "pos_credit_statements_groupId_status_idx" ON "pos_credit_statements"("groupId", "status");

            -- 3. Tabla de ítems de cortes
            CREATE TABLE IF NOT EXISTS "pos_credit_statement_items" (
              "id" TEXT NOT NULL PRIMARY KEY,
              "statementId" TEXT NOT NULL REFERENCES "pos_credit_statements"("id") ON DELETE CASCADE,
              "saleId" TEXT NOT NULL UNIQUE REFERENCES "pos_sales"("id") ON DELETE RESTRICT,
              "customerId" TEXT NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
              "amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
              "settledAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
              "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS "pos_credit_statement_items_statementId_idx" ON "pos_credit_statement_items"("statementId");
            CREATE INDEX IF NOT EXISTS "pos_credit_statement_items_customerId_idx" ON "pos_credit_statement_items"("customerId");

            -- 4. Columnas en customers
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'groupId') THEN
              ALTER TABLE "customers" ADD COLUMN "groupId" TEXT REFERENCES "pos_credit_groups"("id") ON DELETE SET NULL;
            END IF;

            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'externalCode') THEN
              ALTER TABLE "customers" ADD COLUMN "externalCode" VARCHAR(50);
            END IF;

            CREATE UNIQUE INDEX IF NOT EXISTS "customers_businessId_externalCode_key" ON "customers" ("businessId", "externalCode") WHERE "externalCode" IS NOT NULL;
            CREATE INDEX IF NOT EXISTS "customers_businessId_groupId_idx" ON "customers"("businessId", "groupId");

            -- 5. Columna en pos_policies
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_policies' AND column_name = 'creditLimitOverrideRequiresApproval') THEN
              ALTER TABLE "pos_policies" ADD COLUMN "creditLimitOverrideRequiresApproval" BOOLEAN NOT NULL DEFAULT true;
            END IF;
          END $$;`,
        },
        {
          name: 'Clientes phone nullable y limpieza de phone = externalCode (116d)',
          sql: `DO $$ BEGIN
            ALTER TABLE "customers" ALTER COLUMN "phone" DROP NOT NULL;
            UPDATE "customers" SET "phone" = NULL WHERE "phone" = "externalCode" AND "externalCode" IS NOT NULL;
          END $$;`,
        },
        {
          name: 'Modificaciones en users para Social Login',
          sql: `DO $$ BEGIN
            ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "authProvider" "AuthProvider" NOT NULL DEFAULT 'EMAIL';
            ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profileComplete" BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;
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
          name: 'Columna customers.email',
          sql: `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "email" VARCHAR(255);`,
        },
        {
          name: 'Columna customers.notes',
          sql: `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "notes" TEXT;`,
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
              CREATE TYPE "BusinessProductType" AS ENUM ('DELIVERY', 'POS', 'CARTERA_COBRO');
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
            "deliveryMonthlyFee" DECIMAL(10, 2),
            "autoRenew" BOOLEAN NOT NULL DEFAULT true,
            "renewalCanceledAt" TIMESTAMP(3),
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
        {
          name: 'Enum UserRole valor CAJERO',
          sql: `ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'CAJERO';`,
        },
        {
          name: 'Tabla password_change_logs',
          sql: `CREATE TABLE IF NOT EXISTS "password_change_logs" (
            "id" TEXT NOT NULL,
            "targetUserId" TEXT NOT NULL,
            "changedByUserId" TEXT NOT NULL,
            "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "password_change_logs_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "password_change_logs_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "password_change_logs_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice password_change_logs.targetUserId',
          sql: `CREATE INDEX IF NOT EXISTS "password_change_logs_targetUserId_idx" ON "password_change_logs"("targetUserId");`,
        },
        {
          name: 'Índice password_change_logs.changedByUserId',
          sql: `CREATE INDEX IF NOT EXISTS "password_change_logs_changedByUserId_idx" ON "password_change_logs"("changedByUserId");`,
        },
        {
          name: 'Columna pos_sales.soldWithoutOpenShift',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "soldWithoutOpenShift" BOOLEAN NOT NULL DEFAULT false;`,
        },
        {
          name: 'Enum CreditAccountStatus',
          sql: `DO $$ BEGIN CREATE TYPE "CreditAccountStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
        },
        {
          name: 'Columnas customers.creditLimit y ruc',
          sql: `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "creditLimit" DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS "ruc" VARCHAR(30);`,
        },
        {
          name: 'Columna pos_sales.customerId',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "customerId" TEXT REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;`,
        },
        {
          name: 'Índice pos_sales.customerId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_sales_customerId_idx" ON "pos_sales"("customerId");`,
        },
        {
          name: 'Tabla pos_credit_accounts',
          sql: `CREATE TABLE IF NOT EXISTS "pos_credit_accounts" (
            "id" TEXT NOT NULL,
            "saleId" TEXT NOT NULL,
            "customerId" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "originalAmount" DOUBLE PRECISION NOT NULL,
            "balance" DOUBLE PRECISION NOT NULL,
            "status" "CreditAccountStatus" NOT NULL DEFAULT 'PENDING',
            "dueDate" TIMESTAMP(3) NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_credit_accounts_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_credit_accounts_saleId_key" UNIQUE ("saleId"),
            CONSTRAINT "pos_credit_accounts_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "pos_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_credit_accounts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "pos_credit_accounts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice pos_credit_accounts.businessId_status_dueDate',
          sql: `CREATE INDEX IF NOT EXISTS "pos_credit_accounts_businessId_status_dueDate_idx" ON "pos_credit_accounts"("businessId", "status", "dueDate");`,
        },
        {
          name: 'Índice pos_credit_accounts.businessId_customerId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_credit_accounts_businessId_customerId_idx" ON "pos_credit_accounts"("businessId", "customerId");`,
        },
        {
          name: 'Tabla pos_credit_payments',
          sql: `CREATE TABLE IF NOT EXISTS "pos_credit_payments" (
            "id" TEXT NOT NULL,
            "creditAccountId" TEXT NOT NULL,
            "amount" DOUBLE PRECISION NOT NULL,
            "paymentMethod" "PosPaymentMethod" NOT NULL DEFAULT 'EFECTIVO',
            "receivedByUserId" TEXT NOT NULL,
            "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "notes" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_credit_payments_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_credit_payments_creditAccountId_fkey" FOREIGN KEY ("creditAccountId") REFERENCES "pos_credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "pos_credit_payments_receivedByUserId_fkey" FOREIGN KEY ("receivedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice pos_credit_payments.creditAccountId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_credit_payments_creditAccountId_idx" ON "pos_credit_payments"("creditAccountId");`,
        },
        {
          name: 'Enum BusinessProductType - Agregar CARTERA_COBRO',
          sql: `ALTER TYPE "BusinessProductType" ADD VALUE IF NOT EXISTS 'CARTERA_COBRO';`,
        },
        {
          name: 'Columna businesses.hasCarteraCobro',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "hasCarteraCobro" BOOLEAN NOT NULL DEFAULT false;`,
        },
        {
          name: 'Columna business_product_subscriptions.carteraMonthlyFee',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "carteraMonthlyFee" DECIMAL(10, 2);`,
        },
        {
          name: 'Tabla membership_payment_products',
          sql: `CREATE TABLE IF NOT EXISTS "membership_payment_products" (
            "id" TEXT NOT NULL,
            "membershipPaymentId" TEXT NOT NULL,
            "businessProductSubscriptionId" TEXT NOT NULL,
            "amountAttributed" DECIMAL(10, 2),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "membership_payment_products_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "membership_payment_products_membershipPaymentId_businessProductSubscriptionId_key" UNIQUE ("membershipPaymentId", "businessProductSubscriptionId"),
            CONSTRAINT "membership_payment_products_membershipPaymentId_fkey" FOREIGN KEY ("membershipPaymentId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "membership_payment_products_businessProductSubscriptionId_fkey" FOREIGN KEY ("businessProductSubscriptionId") REFERENCES "business_product_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice membership_payment_products.membershipPaymentId',
          sql: `CREATE INDEX IF NOT EXISTS "membership_payment_products_membershipPaymentId_idx" ON "membership_payment_products"("membershipPaymentId");`,
        },
        {
          name: 'Índice membership_payment_products.businessProductSubscriptionId',
          sql: `CREATE INDEX IF NOT EXISTS "membership_payment_products_businessProductSubscriptionId_idx" ON "membership_payment_products"("businessProductSubscriptionId");`,
        },
        {
          name: 'Enum BusinessProductType - Agregar CITAS',
          sql: `ALTER TYPE "BusinessProductType" ADD VALUE IF NOT EXISTS 'CITAS';`,
        },
        {
          name: 'Enum AppointmentStatus',
          sql: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AppointmentStatus') THEN CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'); END IF; END $$;`,
        },
        {
          name: 'Columna businesses.hasCitas',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "hasCitas" BOOLEAN NOT NULL DEFAULT false;`,
        },
        {
          name: 'Columna business_product_subscriptions.citasMonthlyFee',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "citasMonthlyFee" DECIMAL(10, 2);`,
        },
        {
          name: 'Columna business_product_subscriptions.deliveryMonthlyFee',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "deliveryMonthlyFee" DECIMAL(10, 2);`,
        },
        {
          name: 'Enum BusinessProductAction: RENEWAL_CANCELED',
          sql: `ALTER TYPE "BusinessProductAction" ADD VALUE IF NOT EXISTS 'RENEWAL_CANCELED';`,
        },
        {
          name: 'Columna business_product_subscriptions.autoRenew',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "autoRenew" BOOLEAN NOT NULL DEFAULT true;`,
        },
        {
          name: 'Columna business_product_subscriptions.renewalCanceledAt',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "renewalCanceledAt" TIMESTAMP(3);`,
        },
        {
          name: 'Backfill deliveryMonthlyFee para negocios Comercio Común con Delivery activo',
          sql: `UPDATE "business_product_subscriptions" bps
                SET "deliveryMonthlyFee" = 35.00
                FROM "businesses" b
                WHERE bps."businessId" = b."id"
                  AND bps."productType" = 'DELIVERY'
                  AND bps."status" = 'ACTIVE'
                  AND b."businessType" = 'NEGOCIO'
                  AND bps."deliveryMonthlyFee" IS NULL;`,
        },
        {
          name: 'Columna customers.isBlocked',
          sql: `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "isBlocked" BOOLEAN NOT NULL DEFAULT false;`,
        },
        {
          name: 'Columna customers.consecutiveNoShows',
          sql: `ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "consecutiveNoShows" INTEGER NOT NULL DEFAULT 0;`,
        },
        {
          name: 'Tabla booking_services',
          sql: `CREATE TABLE IF NOT EXISTS "booking_services" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "name" VARCHAR(100) NOT NULL,
            "description" VARCHAR(500),
            "durationMinutes" INTEGER NOT NULL,
            "price" DOUBLE PRECISION NOT NULL,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "hasCustomSchedule" BOOLEAN NOT NULL DEFAULT false,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "booking_services_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "booking_services_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice booking_services.businessId_isActive',
          sql: `CREATE INDEX IF NOT EXISTS "booking_services_businessId_isActive_idx" ON "booking_services"("businessId", "isActive");`,
        },
        {
          name: 'Tabla availability_schedules',
          sql: `CREATE TABLE IF NOT EXISTS "availability_schedules" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "serviceId" TEXT,
            "dayOfWeek" INTEGER NOT NULL,
            "startTime" VARCHAR(10) NOT NULL,
            "endTime" VARCHAR(10) NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "availability_schedules_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "availability_schedules_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "availability_schedules_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "booking_services"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice availability_schedules.businessId_serviceId_dayOfWeek',
          sql: `CREATE INDEX IF NOT EXISTS "availability_schedules_businessId_serviceId_dayOfWeek_idx" ON "availability_schedules"("businessId", "serviceId", "dayOfWeek");`,
        },
        {
          name: 'Tabla business_booking_settings',
          sql: `CREATE TABLE IF NOT EXISTS "business_booking_settings" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "minCancellationHours" INTEGER NOT NULL DEFAULT 2,
            "trackNoShows" BOOLEAN NOT NULL DEFAULT false,
            "autoBlockAfterNoShows" BOOLEAN NOT NULL DEFAULT false,
            "noShowThreshold" INTEGER NOT NULL DEFAULT 3,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "business_booking_settings_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "business_booking_settings_businessId_key" UNIQUE ("businessId"),
            CONSTRAINT "business_booking_settings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Tabla appointments',
          sql: `CREATE TABLE IF NOT EXISTS "appointments" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "serviceId" TEXT NOT NULL,
            "customerId" TEXT NOT NULL,
            "scheduledAt" TIMESTAMP(3) NOT NULL,
            "durationMinutes" INTEGER NOT NULL,
            "capacity" INTEGER NOT NULL DEFAULT 1,
            "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDING',
            "price" DOUBLE PRECISION NOT NULL,
            "customerEmail" VARCHAR(255),
            "manageToken" VARCHAR(100) NOT NULL,
            "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
            "cancellationReason" VARCHAR(500),
            "confirmedAt" TIMESTAMP(3),
            "confirmationEmailSentAt" TIMESTAMP(3),
            "cancelledAt" TIMESTAMP(3),
            "completedAt" TIMESTAMP(3),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "appointments_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "appointments_manageToken_key" UNIQUE ("manageToken"),
            CONSTRAINT "appointments_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "appointments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "booking_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "appointments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Columna appointments.confirmationEmailSentAt',
          sql: `ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "confirmationEmailSentAt" TIMESTAMP(3);`,
        },
        {
          name: 'Índice appointments.businessId_status_scheduledAt',
          sql: `CREATE INDEX IF NOT EXISTS "appointments_businessId_status_scheduledAt_idx" ON "appointments"("businessId", "status", "scheduledAt");`,
        },
        {
          name: 'Índice appointments.manageToken',
          sql: `CREATE INDEX IF NOT EXISTS "appointments_manageToken_idx" ON "appointments"("manageToken");`,
        },
        {
          name: 'Tabla appointment_holds',
          sql: `CREATE TABLE IF NOT EXISTS "appointment_holds" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "serviceId" TEXT NOT NULL,
            "specialistId" TEXT NOT NULL,
            "startAt" TIMESTAMP(3) NOT NULL,
            "endAt" TIMESTAMP(3) NOT NULL,
            "holderToken" TEXT NOT NULL,
            "expiresAt" TIMESTAMP(3) NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "appointment_holds_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "appointment_holds_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice appointment_holds.businessId_specialistId_startAt',
          sql: `CREATE INDEX IF NOT EXISTS "appointment_holds_businessId_specialistId_startAt_idx" ON "appointment_holds"("businessId", "specialistId", "startAt");`,
        },
        {
          name: 'Índice appointment_holds.expiresAt',
          sql: `CREATE INDEX IF NOT EXISTS "appointment_holds_expiresAt_idx" ON "appointment_holds"("expiresAt");`,
        },
        {
          name: 'Tabla specialists',
          sql: `CREATE TABLE IF NOT EXISTS "specialists" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "name" VARCHAR(150) NOT NULL,
            "specialty" VARCHAR(150) NOT NULL,
            "active" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "specialists_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "specialists_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice specialists.businessId',
          sql: `CREATE INDEX IF NOT EXISTS "specialists_businessId_idx" ON "specialists"("businessId");`,
        },
        {
          name: 'Columna booking_services.specialistId',
          sql: `ALTER TABLE "booking_services" ADD COLUMN IF NOT EXISTS "specialistId" TEXT;`,
        },
        {
          name: 'Constraint booking_services.specialistId foreign key',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'booking_services_specialistId_fkey'
            ) THEN
              ALTER TABLE "booking_services"
                ADD CONSTRAINT "booking_services_specialistId_fkey"
                FOREIGN KEY ("specialistId") REFERENCES "specialists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            END IF;
          END $$;`,
        },
        {
          name: 'Índice booking_services.specialistId',
          sql: `CREATE INDEX IF NOT EXISTS "booking_services_specialistId_idx" ON "booking_services"("specialistId");`,
        },
        {
          name: 'Columna businesses.slug',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "slug" VARCHAR(100);`,
        },
        {
          name: 'Índice único businesses.slug',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "businesses_slug_key" ON "businesses"("slug");`,
        },
        {
          name: 'Tabla services',
          sql: `CREATE TABLE IF NOT EXISTS "services" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "name" VARCHAR(100) NOT NULL,
            "description" VARCHAR(500),
            "durationMinutes" INTEGER NOT NULL,
            "price" DOUBLE PRECISION NOT NULL,
            "active" BOOLEAN NOT NULL DEFAULT true,
            "hasCustomSchedule" BOOLEAN NOT NULL DEFAULT false,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "services_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "services_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice services.businessId_active',
          sql: `CREATE INDEX IF NOT EXISTS "services_businessId_active_idx" ON "services"("businessId", "active");`,
        },
        {
          name: 'Tabla service_specialists',
          sql: `CREATE TABLE IF NOT EXISTS "service_specialists" (
            "id" TEXT NOT NULL,
            "serviceId" TEXT NOT NULL,
            "specialistId" TEXT NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "service_specialists_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "service_specialists_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "service_specialists_specialistId_fkey" FOREIGN KEY ("specialistId") REFERENCES "specialists"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "service_specialists_serviceId_specialistId_key" UNIQUE ("serviceId", "specialistId")
          );`,
        },
        {
          name: 'Índice service_specialists.serviceId',
          sql: `CREATE INDEX IF NOT EXISTS "service_specialists_serviceId_idx" ON "service_specialists"("serviceId");`,
        },
        {
          name: 'Índice service_specialists.specialistId',
          sql: `CREATE INDEX IF NOT EXISTS "service_specialists_specialistId_idx" ON "service_specialists"("specialistId");`,
        },
        {
          name: 'Columna appointments.specialistId',
          sql: `ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "specialistId" TEXT;`,
        },
        {
          name: 'Constraint appointments.specialistId foreign key',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'appointments_specialistId_fkey'
            ) THEN
              ALTER TABLE "appointments"
                ADD CONSTRAINT "appointments_specialistId_fkey"
                FOREIGN KEY ("specialistId") REFERENCES "specialists"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            END IF;
          END $$;`,
        },
        {
          name: 'Índice appointments.specialistId',
          sql: `CREATE INDEX IF NOT EXISTS "appointments_specialistId_idx" ON "appointments"("specialistId");`,
        },
        {
          name: 'Tabla professions',
          sql: `CREATE TABLE IF NOT EXISTS "professions" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "name" VARCHAR(60) NOT NULL,
            "active" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "professions_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "professions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "professions_businessId_name_key" UNIQUE ("businessId", "name")
          );`,
        },
        {
          name: 'Índice professions.businessId',
          sql: `CREATE INDEX IF NOT EXISTS "professions_businessId_idx" ON "professions"("businessId");`,
        },
        {
          name: 'Columna specialists.professionId',
          sql: `ALTER TABLE "specialists" ADD COLUMN IF NOT EXISTS "professionId" TEXT;`,
        },
        {
          name: 'Constraint specialists.professionId foreign key',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'specialists_professionId_fkey'
            ) THEN
              ALTER TABLE "specialists"
                ADD CONSTRAINT "specialists_professionId_fkey"
                FOREIGN KEY ("professionId") REFERENCES "professions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            END IF;
          END $$;`,
        },
        {
          name: 'Índice specialists.professionId',
          sql: `CREATE INDEX IF NOT EXISTS "specialists_professionId_idx" ON "specialists"("professionId");`,
        },
        {
          name: 'Columna specialists.specialty nullable',
          sql: `ALTER TABLE "specialists" ALTER COLUMN "specialty" DROP NOT NULL;`,
        },

        // 75a: Snapshot inmutable de nombre y teléfono en Appointment
        {
          name: 'Columna appointments.customerName',
          sql: `ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "customerName" VARCHAR(100) NOT NULL DEFAULT '';`,
        },
        {
          name: 'Columna appointments.customerPhone',
          sql: `ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "customerPhone" VARCHAR(30);`,
        },
        {
          name: 'Backfill appointments.customerName y customerPhone desde customers',
          sql: `UPDATE "appointments" a
SET "customerName" = COALESCE(NULLIF(TRIM(c."name"), ''), 'Cliente'),
    "customerPhone" = COALESCE(a."customerPhone", c."phone")
FROM "customers" c
WHERE a."customerId" = c."id"
  AND (a."customerName" IS NULL OR a."customerName" = '');`,
        },
        {
          name: 'Backfill fallback appointments.customerName para registros huérfanos',
          sql: `UPDATE "appointments" SET "customerName" = 'Cliente' WHERE "customerName" IS NULL OR "customerName" = '';`,
        },

        // 78a: Modelo Waiter y snapshots en TableOrder / TableOrderItem
        {
          name: 'Enum UserRole - Agregar WAITER',
          sql: `ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'WAITER';`,
        },
        {
          name: 'Tabla pos_waiters',
          sql: `CREATE TABLE IF NOT EXISTS "pos_waiters" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "name" VARCHAR(100) NOT NULL,
            "pinHash" VARCHAR(100) NOT NULL,
            "active" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_waiters_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_waiters_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice pos_waiters.businessId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_waiters_businessId_idx" ON "pos_waiters"("businessId");`,
        },
        {
          name: 'Columna pos_table_orders.openedByWaiterId',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "openedByWaiterId" VARCHAR(100);`,
        },
        {
          name: 'Columna pos_table_orders.openedByWaiterName',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "openedByWaiterName" VARCHAR(100);`,
        },
        {
          name: 'Columna pos_table_order_items.waiterId',
          sql: `ALTER TABLE "pos_table_order_items" ADD COLUMN IF NOT EXISTS "waiterId" VARCHAR(100);`,
        },
        {
          name: 'Columna pos_table_order_items.waiterName',
          sql: `ALTER TABLE "pos_table_order_items" ADD COLUMN IF NOT EXISTS "waiterName" VARCHAR(100);`,
        },
        {
          name: 'Enum TableOrderStatus valor CANCELLED',
          sql: `ALTER TYPE "TableOrderStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';`,
        },
        {
          name: 'Columna pos_table_orders.cancelledAt',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);`,
        },
        {
          name: 'Columna pos_table_orders.cancelledByUserId',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "cancelledByUserId" VARCHAR(100);`,
        },
        {
          name: 'Columna pos_table_orders.cancelledByUserName',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "cancelledByUserName" VARCHAR(100);`,
        },
        {
          name: 'Columna pos_table_orders.cancellationReason',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "cancellationReason" VARCHAR(500);`,
        },
        {
          name: 'Columna service_specialists.commissionPercent',
          sql: `ALTER TABLE "service_specialists" ADD COLUMN IF NOT EXISTS "commissionPercent" DOUBLE PRECISION;`,
        },
        {
          name: 'Columna appointments.saleId',
          sql: `ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "saleId" VARCHAR(100);`,
        },
        {
          name: 'Columna appointments.serviceId nullable',
          sql: `ALTER TABLE "appointments" ALTER COLUMN "serviceId" DROP NOT NULL;`,
        },
        {
          name: 'Tabla appointment_service_items',
          sql: `CREATE TABLE IF NOT EXISTS "appointment_service_items" (
            "id" TEXT NOT NULL,
            "appointmentId" TEXT NOT NULL,
            "serviceId" TEXT NOT NULL,
            "serviceName" VARCHAR(150) NOT NULL,
            "price" DOUBLE PRECISION NOT NULL,
            "durationMinutes" INTEGER NOT NULL,
            "orderIndex" INTEGER NOT NULL DEFAULT 0,
            CONSTRAINT "appointment_service_items_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "appointment_service_items_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice appointment_service_items.appointmentId',
          sql: `CREATE INDEX IF NOT EXISTS "appointment_service_items_appointmentId_idx" ON "appointment_service_items"("appointmentId");`,
        },
        {
          name: 'Columna appointment_holds.serviceIds',
          sql: `ALTER TABLE "appointment_holds" ADD COLUMN IF NOT EXISTS "serviceIds" TEXT[] NOT NULL DEFAULT '{}';`,
        },
        {
          name: 'Migración appointment_holds.serviceIds desde serviceId',
          sql: `DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'appointment_holds' AND column_name = 'serviceId') THEN
              UPDATE "appointment_holds" SET "serviceIds" = ARRAY["serviceId"] WHERE ("serviceIds" IS NULL OR "serviceIds" = '{}') AND "serviceId" IS NOT NULL;
              ALTER TABLE "appointment_holds" ALTER COLUMN "serviceId" DROP NOT NULL;
            END IF;
          END $$;`,
        },
        {
          name: 'Enums NotificationChannel y NotificationLogStatus',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationChannel') THEN
              CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP');
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationLogStatus') THEN
              CREATE TYPE "NotificationLogStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SIMULATED');
            END IF;
          END $$;`,
        },
        {
          name: 'Tabla notification_logs',
          sql: `CREATE TABLE IF NOT EXISTS "notification_logs" (
            "id" TEXT NOT NULL,
            "businessId" TEXT,
            "channel" "NotificationChannel" NOT NULL,
            "event" VARCHAR(100) NOT NULL,
            "recipientContact" VARCHAR(255) NOT NULL,
            "status" "NotificationLogStatus" NOT NULL DEFAULT 'PENDING',
            "sentAt" TIMESTAMP(3),
            "errorMessage" TEXT,
            "relatedEntityType" VARCHAR(100),
            "relatedEntityId" VARCHAR(100),
            "metadata" JSONB,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "notification_logs_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Columna businesses.extraUserSlots',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "extraUserSlots" INTEGER NOT NULL DEFAULT 0;`,
        },
        {
          name: 'Índice notification_logs.businessId',
          sql: `CREATE INDEX IF NOT EXISTS "notification_logs_businessId_idx" ON "notification_logs"("businessId");`,
        },
        {
          name: 'Índice notification_logs.channel_event',
          sql: `CREATE INDEX IF NOT EXISTS "notification_logs_channel_event_idx" ON "notification_logs"("channel", "event");`,
        },
        {
          name: 'Índice notification_logs.relatedEntityType_relatedEntityId',
          sql: `CREATE INDEX IF NOT EXISTS "notification_logs_relatedEntityType_relatedEntityId_idx" ON "notification_logs"("relatedEntityType", "relatedEntityId");`,
        },
        {
          name: 'Índice notification_logs.recipientContact',
          sql: `CREATE INDEX IF NOT EXISTS "notification_logs_recipientContact_idx" ON "notification_logs"("recipientContact");`,
        },
        {
          name: 'Índice notification_logs.status',
          sql: `CREATE INDEX IF NOT EXISTS "notification_logs_status_idx" ON "notification_logs"("status");`,
        },
        // ==========================================
        // MÓDULO 103a: Industrias y Campos Dinámicos
        // ==========================================
        {
          name: 'Enum ProductFieldDataType',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProductFieldDataType') THEN
              CREATE TYPE "ProductFieldDataType" AS ENUM ('TEXT', 'NUMBER', 'SELECT', 'BOOLEAN', 'DATE');
            END IF;
          END $$;`,
        },
        {
          name: 'Tabla industries',
          sql: `CREATE TABLE IF NOT EXISTS "industries" (
            "id" TEXT NOT NULL,
            "code" VARCHAR(50) NOT NULL,
            "name" VARCHAR(100) NOT NULL,
            "posVertical" "PosVertical" NOT NULL DEFAULT 'RETAIL',
            "usesVariants" BOOLEAN NOT NULL DEFAULT false,
            "tracksBatches" BOOLEAN NOT NULL DEFAULT false,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "order" INTEGER NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "industries_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "industries_code_key" UNIQUE ("code")
          );`,
        },
        {
          name: 'Tabla industry_field_templates',
          sql: `CREATE TABLE IF NOT EXISTS "industry_field_templates" (
            "id" TEXT NOT NULL,
            "industryId" TEXT NOT NULL,
            "key" VARCHAR(50) NOT NULL,
            "label" VARCHAR(100) NOT NULL,
            "dataType" "ProductFieldDataType" NOT NULL,
            "required" BOOLEAN NOT NULL DEFAULT false,
            "options" JSONB,
            "order" INTEGER NOT NULL DEFAULT 0,
            "searchable" BOOLEAN NOT NULL DEFAULT false,
            "showInPos" BOOLEAN NOT NULL DEFAULT false,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "industry_field_templates_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "industry_field_templates_industryId_key_key" UNIQUE ("industryId", "key"),
            CONSTRAINT "industry_field_templates_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "industries"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Tabla product_field_definitions',
          sql: `CREATE TABLE IF NOT EXISTS "product_field_definitions" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "key" VARCHAR(50) NOT NULL,
            "label" VARCHAR(100) NOT NULL,
            "dataType" "ProductFieldDataType" NOT NULL,
            "required" BOOLEAN NOT NULL DEFAULT false,
            "options" JSONB,
            "order" INTEGER NOT NULL DEFAULT 0,
            "searchable" BOOLEAN NOT NULL DEFAULT false,
            "showInPos" BOOLEAN NOT NULL DEFAULT false,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "product_field_definitions_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "product_field_definitions_businessId_key_key" UNIQUE ("businessId", "key"),
            CONSTRAINT "product_field_definitions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: 'Índice product_field_definitions.businessId_isActive',
          sql: `CREATE INDEX IF NOT EXISTS "product_field_definitions_businessId_isActive_idx" ON "product_field_definitions"("businessId", "isActive");`,
        },
        {
          name: 'Columnas businesses.industryId, usesVariants, tracksBatches',
          sql: `DO $$ BEGIN
            ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "industryId" TEXT;
            ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "usesVariants" BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "tracksBatches" BOOLEAN NOT NULL DEFAULT false;
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.table_constraints
              WHERE constraint_name = 'businesses_industryId_fkey'
            ) THEN
              ALTER TABLE "businesses" ADD CONSTRAINT "businesses_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "industries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            END IF;
          END $$;`,
        },
        {
          name: 'Columnas de configuración de impuestos en businesses y pos_sales',
          sql: `DO $$ BEGIN
            ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "taxConfiguredAt" TIMESTAMP(3);
            ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "taxEnabled" BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 0;
            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "taxEnabled" BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
          END $$;`,
        },
        {
          name: 'Columna pos_products.attributes e índice GIN',
          sql: `DO $$ BEGIN
            ALTER TABLE "pos_products" ADD COLUMN IF NOT EXISTS "attributes" JSONB NOT NULL DEFAULT '{}';
            CREATE INDEX IF NOT EXISTS "idx_pos_products_attributes" ON "pos_products" USING GIN ("attributes");
          END $$;`,
        },
        {
          name: 'Tabla platform_settings',
          sql: `CREATE TABLE IF NOT EXISTS "platform_settings" (
            "key" VARCHAR(100) NOT NULL,
            "value" TEXT NOT NULL,
            "description" VARCHAR(255),
            "updatedByUserId" VARCHAR(100),
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
          );`,
        },
        {
          name: '125a - Tabla pos_salon_zones',
          sql: `CREATE TABLE IF NOT EXISTS "pos_salon_zones" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "name" VARCHAR(50) NOT NULL,
            "sortOrder" INTEGER NOT NULL DEFAULT 0,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_salon_zones_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_salon_zones_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: '125a - Índice pos_salon_zones.businessId_isActive',
          sql: `CREATE INDEX IF NOT EXISTS "pos_salon_zones_businessId_isActive_idx" ON "pos_salon_zones"("businessId", "isActive");`,
        },
        {
          name: '125a - Índice único pos_salon_zones por businessId y name en minúsculas',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "pos_salon_zones_business_name_lower_idx" ON "pos_salon_zones" ("businessId", LOWER("name")) WHERE "isActive" = true;`,
        },
        {
          name: '125a - Columna pos_restaurant_tables.zoneId',
          sql: `ALTER TABLE "pos_restaurant_tables" ADD COLUMN IF NOT EXISTS "zoneId" TEXT;`,
        },
        {
          name: '125a - Constraint pos_restaurant_tables.zoneId foreign key',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'pos_restaurant_tables_zoneId_fkey'
            ) THEN
              ALTER TABLE "pos_restaurant_tables"
                ADD CONSTRAINT "pos_restaurant_tables_zoneId_fkey"
                FOREIGN KEY ("zoneId") REFERENCES "pos_salon_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            END IF;
          END $$;`,
        },
        {
          name: '125a - Índice pos_restaurant_tables.zoneId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_restaurant_tables_zoneId_idx" ON "pos_restaurant_tables"("zoneId");`,
        },
        {
          name: '132a - Enum PosDeviceStatus',
          sql: `DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PosDeviceStatus') THEN
              CREATE TYPE "PosDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');
            END IF;
          END $$;`,
        },
        {
          name: '132a - Tabla pos_devices',
          sql: `CREATE TABLE IF NOT EXISTS "pos_devices" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "deviceId" VARCHAR(100) NOT NULL,
            "name" VARCHAR(100),
            "platform" VARCHAR(50),
            "appVersion" VARCHAR(50),
            "status" "PosDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
            "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastUserId" VARCHAR(100),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_devices_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_devices_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: '132a - Índice único pos_devices.businessId_deviceId',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "pos_devices_businessId_deviceId_key" ON "pos_devices"("businessId", "deviceId");`,
        },
        {
          name: '132a - Índice pos_devices.businessId_status',
          sql: `CREATE INDEX IF NOT EXISTS "pos_devices_businessId_status_idx" ON "pos_devices"("businessId", "status");`,
        },
        {
          name: '132a - Columna business_product_subscriptions.maxDevices',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "maxDevices" INTEGER;`,
        },
        {
          name: '136a - Columna unit en pos_products',
          sql: `ALTER TABLE "pos_products" ADD COLUMN IF NOT EXISTS "unit" VARCHAR(10) NOT NULL DEFAULT 'UND';`,
        },
        {
          name: '136a - pos_products.stock DECIMAL(12,3)',
          sql: `ALTER TABLE "pos_products" ALTER COLUMN "stock" TYPE DECIMAL(12,3) USING "stock"::DECIMAL(12,3), ALTER COLUMN "stock" SET DEFAULT 0;`,
        },
        {
          name: '136a - pos_products.minStock DECIMAL(12,3)',
          sql: `ALTER TABLE "pos_products" ALTER COLUMN "minStock" TYPE DECIMAL(12,3) USING "minStock"::DECIMAL(12,3), ALTER COLUMN "minStock" SET DEFAULT 5;`,
        },
        {
          name: '136a - pos_products.maxStock DECIMAL(12,3)',
          sql: `ALTER TABLE "pos_products" ALTER COLUMN "maxStock" TYPE DECIMAL(12,3) USING "maxStock"::DECIMAL(12,3);`,
        },
        {
          name: '136a - pos_stock_movements decimales',
          sql: `ALTER TABLE "pos_stock_movements" 
            ALTER COLUMN "quantity" TYPE DECIMAL(12,3) USING "quantity"::DECIMAL(12,3),
            ALTER COLUMN "stockBefore" TYPE DECIMAL(12,3) USING "stockBefore"::DECIMAL(12,3),
            ALTER COLUMN "stockAfter" TYPE DECIMAL(12,3) USING "stockAfter"::DECIMAL(12,3);`,
        },
        {
          name: '136a - pos_table_order_items.quantity DECIMAL(12,3)',
          sql: `ALTER TABLE "pos_table_order_items" ALTER COLUMN "quantity" TYPE DECIMAL(12,3) USING "quantity"::DECIMAL(12,3);`,
        },
        {
          name: '136a - pos_purchase_items.quantity DECIMAL(12,3)',
          sql: `ALTER TABLE "pos_purchase_items" ALTER COLUMN "quantity" TYPE DECIMAL(12,3) USING "quantity"::DECIMAL(12,3);`,
        },
        {
          name: '136a - pos_inventory_adjustments.qtyDelta DECIMAL(12,3)',
          sql: `ALTER TABLE "pos_inventory_adjustments" ALTER COLUMN "qtyDelta" TYPE DECIMAL(12,3) USING "qtyDelta"::DECIMAL(12,3);`,
        },
        {
          name: '136a - pos_inventory_discrepancies decimales',
          sql: `ALTER TABLE "pos_inventory_discrepancies" 
            ALTER COLUMN "expectedStock" TYPE DECIMAL(12,3) USING "expectedStock"::DECIMAL(12,3),
            ALTER COLUMN "resultingStock" TYPE DECIMAL(12,3) USING "resultingStock"::DECIMAL(12,3);`,
        },
        {
          name: '137a - Columna isRecipe en pos_products',
          sql: `ALTER TABLE "pos_products" ADD COLUMN IF NOT EXISTS "isRecipe" BOOLEAN NOT NULL DEFAULT false;`,
        },
        {
          name: '137a - Tabla pos_product_components',
          sql: `CREATE TABLE IF NOT EXISTS "pos_product_components" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "parentProductId" TEXT NOT NULL,
            "componentProductId" TEXT NOT NULL,
            "quantity" DECIMAL(12,3) NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "pos_product_components_pkey" PRIMARY KEY ("id"),
            CONSTRAINT "pos_product_components_parentProductId_fkey" FOREIGN KEY ("parentProductId") REFERENCES "pos_products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_product_components_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES "pos_products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "pos_product_components_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE
          );`,
        },
        {
          name: '137a - Índice pos_product_components.parent_component',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "pos_product_components_parentProductId_componentProductId_key" ON "pos_product_components"("parentProductId", "componentProductId");`,
        },
        {
          name: '137a - Índice pos_product_components.businessId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_product_components_businessId_idx" ON "pos_product_components"("businessId");`,
        },
        {
          name: '137a - Índice pos_product_components.parentProductId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_product_components_parentProductId_idx" ON "pos_product_components"("parentProductId");`,
        },
        {
          name: '137a - Índice pos_product_components.componentProductId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_product_components_componentProductId_idx" ON "pos_product_components"("componentProductId");`,
        },
        {
          name: '138a - Columna businesses.salonProfile',
          sql: `ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "salonProfile" VARCHAR(50) DEFAULT 'RESTAURANTE';`,
        },
        {
          name: '138a - Default salonProfile en businesses',
          sql: `UPDATE "businesses" SET "salonProfile" = 'RESTAURANTE' WHERE "salonProfile" IS NULL;`,
        },
        {
          name: '138a - pos_restaurant_tables.gridX DROP NOT NULL',
          sql: `ALTER TABLE "pos_restaurant_tables" ALTER COLUMN "gridX" DROP NOT NULL;`,
        },
        {
          name: '138a - pos_restaurant_tables.gridY DROP NOT NULL',
          sql: `ALTER TABLE "pos_restaurant_tables" ALTER COLUMN "gridY" DROP NOT NULL;`,
        },
        {
          name: '142a - pos_table_orders.customerName',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "customerName" VARCHAR(120);`,
        },
        {
          name: '142a - pos_table_orders.customerPhone',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "customerPhone" VARCHAR(30);`,
        },
        {
          name: '142a - pos_table_orders.vehicleInfo',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "vehicleInfo" VARCHAR(120);`,
        },
        {
          name: '142a - pos_table_orders.assignedWaiterId',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "assignedWaiterId" TEXT;`,
        },
        {
          name: '142a - pos_table_orders.assignedWaiterId FK',
          sql: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_table_orders_assignedWaiterId_fkey') THEN ALTER TABLE "pos_table_orders" ADD CONSTRAINT "pos_table_orders_assignedWaiterId_fkey" FOREIGN KEY ("assignedWaiterId") REFERENCES "pos_waiters"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;`,
        },
        {
          name: '142a - pos_table_orders.assignedWaiterId IDX',
          sql: `CREATE INDEX IF NOT EXISTS "pos_table_orders_assignedWaiterId_idx" ON "pos_table_orders"("assignedWaiterId");`,
        },
        {
          name: '142a - pos_sales.tableNumber',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "tableNumber" VARCHAR(50);`,
        },
        {
          name: '142a - pos_sales.zoneName',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "zoneName" VARCHAR(100);`,
        },
        {
          name: '142a - pos_sales.waiterName',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "waiterName" VARCHAR(100);`,
        },
        {
          name: '142a - pos_sales.vehicleInfo',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "vehicleInfo" VARCHAR(120);`,
        },
        {
          name: '142a - pos_sales.customerName VARCHAR(120)',
          sql: `ALTER TABLE "pos_sales" ALTER COLUMN "customerName" TYPE VARCHAR(120);`,
        },
        {
          name: '143a - Seed industria Taller / Servicios automotrices',
          sql: `INSERT INTO "industries" ("id", "code", "name", "posVertical", "usesVariants", "tracksBatches", "isActive", "order", "createdAt", "updatedAt") VALUES (gen_random_uuid(), 'taller', 'Taller / Servicios automotrices (POS: Taller)', 'RETAIL', false, false, true, 8, NOW(), NOW()) ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "posVertical" = EXCLUDED."posVertical";`,
        },
        {
          name: '144a - business_product_subscriptions.backofficeTier VARCHAR(20) DEFAULT BASIC',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "backofficeTier" VARCHAR(20) DEFAULT 'BASIC';`,
        },
        {
          name: '147a - business_product_subscriptions.trialHours INTEGER',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "trialHours" INTEGER;`,
        },
        {
          name: '147a - business_product_subscriptions.trialStartedAt TIMESTAMPTZ',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "trialStartedAt" TIMESTAMPTZ;`,
        },
        {
          name: '147a - business_product_subscriptions.trialEndsAt TIMESTAMPTZ',
          sql: `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMPTZ;`,
        },
        {
          name: '155a - CREATE TABLE workshop_vehicles',
          sql: `CREATE TABLE IF NOT EXISTS "workshop_vehicles" (
            "id" TEXT NOT NULL,
            "businessId" TEXT NOT NULL,
            "plate" VARCHAR(50) NOT NULL,
            "normalizedPlate" VARCHAR(50) NOT NULL,
            "description" VARCHAR(200),
            "customerId" TEXT,
            "lastMileage" INTEGER,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "workshop_vehicles_pkey" PRIMARY KEY ("id")
          );`,
        },
        {
          name: '155a - UNIQUE INDEX workshop_vehicles businessId normalizedPlate',
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "workshop_vehicles_businessId_normalizedPlate_key" ON "workshop_vehicles" ("businessId", "normalizedPlate");`,
        },
        {
          name: '155a - INDEX workshop_vehicles businessId customerId',
          sql: `CREATE INDEX IF NOT EXISTS "workshop_vehicles_businessId_customerId_idx" ON "workshop_vehicles" ("businessId", "customerId");`,
        },
        {
          name: '155a - INDEX workshop_vehicles businessId normalizedPlate',
          sql: `CREATE INDEX IF NOT EXISTS "workshop_vehicles_businessId_normalizedPlate_idx" ON "workshop_vehicles" ("businessId", "normalizedPlate");`,
        },
        {
          name: '155a - ALTER TABLE pos_table_orders ADD workshopVehicleId',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "workshopVehicleId" TEXT;`,
        },
        {
          name: '155a - ALTER TABLE pos_table_orders ADD customerId',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "customerId" TEXT;`,
        },
        {
          name: '155a - ALTER TABLE pos_table_orders ADD mileage',
          sql: `ALTER TABLE "pos_table_orders" ADD COLUMN IF NOT EXISTS "mileage" INTEGER;`,
        },
        {
          name: '155a - INDEX pos_table_orders workshopVehicleId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_table_orders_workshopVehicleId_idx" ON "pos_table_orders" ("workshopVehicleId");`,
        },
        {
          name: '155a - INDEX pos_table_orders customerId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_table_orders_customerId_idx" ON "pos_table_orders" ("customerId");`,
        },
        {
          name: '155a - ALTER TABLE pos_sales ADD workshopVehicleId',
          sql: `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "workshopVehicleId" TEXT;`,
        },
        {
          name: '155a - INDEX pos_sales workshopVehicleId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_sales_workshopVehicleId_idx" ON "pos_sales" ("workshopVehicleId");`,
        },
        {
          name: '157a - INDEX pos_table_orders businessId customerId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_table_orders_businessId_customerId_idx" ON "pos_table_orders" ("businessId", "customerId");`,
        },
        {
          name: '157a - INDEX pos_sales businessId customerId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_sales_businessId_customerId_idx" ON "pos_sales" ("businessId", "customerId");`,
        },
        {
          name: '158a - INDEX pos_sales businessId status createdAt',
          sql: `CREATE INDEX IF NOT EXISTS "pos_sales_businessId_status_createdAt_idx" ON "pos_sales" ("businessId", "status", "createdAt");`,
        },
        {
          name: '158a - INDEX pos_sale_items saleId',
          sql: `CREATE INDEX IF NOT EXISTS "pos_sale_items_saleId_idx" ON "pos_sale_items" ("saleId");`,
        },
        {
          name: '158a - INDEX pos_cash_registers businessId status closedAt',
          sql: `CREATE INDEX IF NOT EXISTS "pos_cash_registers_businessId_status_closedAt_idx" ON "pos_cash_registers" ("businessId", "status", "closedAt");`,
        },
      ];

      for (const step of ddlStatements) {
        try {
          await this.$executeRawUnsafe(step.sql);
          this.logger.log(`[PrismaService] ✓ Sincronizado: ${step.name}`);
        } catch (stepErr: any) {
          if (
            stepErr.message &&
            stepErr.message.includes('cannot insert multiple commands into a prepared statement')
          ) {
            try {
              const subQueries = step.sql
                .split(';')
                .map((q) => q.trim())
                .filter((q) => q.length > 0);
              for (const subQ of subQueries) {
                await this.$executeRawUnsafe(subQ);
              }
              this.logger.log(`[PrismaService] ✓ Sincronizado (sub-queries): ${step.name}`);
              continue;
            } catch (subErr: any) {
              this.logger.warn(`[PrismaService] ⚠ Advertencia en ${step.name} (sub-queries): ${subErr.message}`);
              continue;
            }
          }
          this.logger.warn(`[PrismaService] ⚠ Advertencia en ${step.name}: ${stepErr.message}`);
        }
      }

      this.logger.log('[PrismaService] Esquema de base de datos verificado y listo.');

      await this.ensureProductTypeColumn();
      await this.ensureWebBillingColumns();

      await this.ensureBusinessProductsBackfilled();

      await this.reconcileProductTrackStock();

      await this.ensureBusinessSlugsBackfilled();

      await this.ensureServicesMigrated();

      await this.ensureProfessionsMigrated();

      await this.ensureIndustriesAndFieldTemplatesSeeded();

      await this.ensureBusinessesMigratedToIndustries();
      await this.ensureTaxConfigurationBackfilled();
      await this.ensurePosPoliciesBackfilled();
      await this.ensurePosPaymentsBackfilled();
      await this.ensureSalonZonesBackfilled();
    } catch (err: any) {
      this.logger.warn(`[PrismaService] Advertencia general en auto-sincronización de esquema: ${err.message}`);
    }
  }

  /**
   * 160d - Columna pos_products."type" ('PRODUCT' | 'SERVICE').
   * Se crea una sola vez. El backfill corre SOLO en la misma transacción que crea la columna:
   * si la columna ya existe no se toca ningún dato (no pisa cambios manuales).
   * DDL transaccional de Postgres: si el backfill falla, la columna tampoco queda creada y se reintenta
   * en el próximo arranque. El advisory lock evita que dos instancias lo hagan en paralelo.
   * Backfill: SERVICE solo si trackStock = false Y sku empieza con 'SRV-'. Nada más.
   */
  private async ensureProductTypeColumn(): Promise<void> {
    try {
      await this.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1600400)`);
          const existing: any[] = await tx.$queryRawUnsafe(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'pos_products' AND column_name = 'type'`,
          );
          if (existing.length > 0) {
            this.logger.log('[PrismaService] ✓ 160d - pos_products.type ya existe; sin backfill.');
            return;
          }
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_products" ADD COLUMN IF NOT EXISTS "type" VARCHAR(10) NOT NULL DEFAULT 'PRODUCT'`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_products" ADD CONSTRAINT "pos_products_type_check" CHECK ("type" IN ('PRODUCT', 'SERVICE'))`,
          );
          const marked = await tx.$executeRawUnsafe(
            `UPDATE "pos_products" SET "type" = 'SERVICE' WHERE "trackStock" = false AND "sku" LIKE 'SRV-%'`,
          );
          this.logger.log(
            `[PrismaService] ✓ 160d - Columna pos_products.type creada. Backfill: ${marked} producto(s) marcados SERVICE (trackStock=false y sku 'SRV-%').`,
          );
        },
        { timeout: 60000 },
      );
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ 160d - Advertencia creando pos_products.type: ${err.message}`);
    }
  }

  /**
   * 165a - Columnas para facturación web, límite de dispositivos web y canal de venta:
   * - business_product_subscriptions: webBillingEnabled (boolean default false), maxWebDevices (int default 2)
   * - pos_devices: category (varchar(20) default 'DESKTOP'), userId (varchar(100)), userAgent (varchar(500)), ipAddress (varchar(100)), secretHash (varchar(100))
   * - pos_sales: channel (varchar(20)), deviceId (varchar(100))
   * DDL idempotente (ADD COLUMN IF NOT EXISTS) con advisory lock.
   */
  private async ensureWebBillingColumns(): Promise<void> {
    try {
      await this.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1650100)`);

          // 1. business_product_subscriptions
          await tx.$executeRawUnsafe(
            `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "webBillingEnabled" BOOLEAN NOT NULL DEFAULT false`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "business_product_subscriptions" ADD COLUMN IF NOT EXISTS "maxWebDevices" INTEGER DEFAULT 2`,
          );

          // 2. pos_devices
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "category" VARCHAR(20) NOT NULL DEFAULT 'DESKTOP'`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "userId" VARCHAR(100)`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "userAgent" VARCHAR(500)`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "ipAddress" VARCHAR(100)`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "secretHash" VARCHAR(100)`,
          );
          await tx.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "pos_devices_businessId_category_status_idx" ON "pos_devices"("businessId", "category", "status")`,
          );

          // 3. pos_sales
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "channel" VARCHAR(20)`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "pos_sales" ADD COLUMN IF NOT EXISTS "deviceId" VARCHAR(100)`,
          );
          await tx.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "pos_sales_businessId_channel_idx" ON "pos_sales"("businessId", "channel")`,
          );

          this.logger.log(
            `[PrismaService] ✓ 165a - Columnas de facturación web sincronizadas (business_product_subscriptions, pos_devices, pos_sales).`,
          );
        },
        { timeout: 60000 },
      );
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ 165a - Advertencia creando columnas de facturación web: ${err.message}`);
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
      let carteraCreated = 0;
      let citasCreated = 0;
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
              deliveryMonthlyFee: b.businessType === BusinessType.NEGOCIO ? new Prisma.Decimal(35.00) : null,
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
        }

        const existingCartera = b.productSubscriptions.find(
          (s) => s.productType === BusinessProductType.CARTERA_COBRO,
        );

        if (!existingCartera) {
          const isCarteraActive = (b as any).hasCarteraCobro === true;
          await this.businessProductSubscription.create({
            data: {
              businessId: b.id,
              productType: BusinessProductType.CARTERA_COBRO,
              status: isCarteraActive ? BusinessProductStatus.ACTIVE : BusinessProductStatus.INACTIVE,
              carteraMonthlyFee: null,
              activatedAt: isCarteraActive ? b.createdAt : null,
              activatedBy: isCarteraActive ? 'system-migration' : null,
            },
          });

          if (isCarteraActive) {
            await this.businessProductAuditLog.create({
              data: {
                businessId: b.id,
                productType: BusinessProductType.CARTERA_COBRO,
                action: BusinessProductAction.ACTIVATED,
                performedBy: 'system-migration',
                reason: 'Backfill inicial automático por migración a productos independientes (hasCarteraCobro activo)',
                metadata: {},
              },
            });
          }
          carteraCreated++;
        }

        const existingCitas = b.productSubscriptions.find(
          (s) => s.productType === BusinessProductType.CITAS,
        );

        if (!existingCitas) {
          const isCitasActive = (b as any).hasCitas === true;
          await this.businessProductSubscription.create({
            data: {
              businessId: b.id,
              productType: BusinessProductType.CITAS,
              status: isCitasActive ? BusinessProductStatus.ACTIVE : BusinessProductStatus.INACTIVE,
              citasMonthlyFee: null,
              activatedAt: isCitasActive ? b.createdAt : null,
              activatedBy: isCitasActive ? 'system-migration' : null,
            },
          });

          if (isCitasActive) {
            await this.businessProductAuditLog.create({
              data: {
                businessId: b.id,
                productType: BusinessProductType.CITAS,
                action: BusinessProductAction.ACTIVATED,
                performedBy: 'system-migration',
                reason: 'Backfill inicial automático por migración a productos independientes (hasCitas activo)',
                metadata: {},
              },
            });
          }
          citasCreated++;
        } else {
          skipped++;
        }
      }

      if (deliveryCreated > 0 || posCreated > 0 || carteraCreated > 0 || citasCreated > 0) {
        this.logger.log(
          `[PrismaService] ✓ Backfill completado: ${deliveryCreated} DELIVERY, ${posCreated} POS, ${carteraCreated} CARTERA_COBRO, ${citasCreated} CITAS (${skipped} ya existían).`,
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

  private async ensureBusinessSlugsBackfilled() {
    try {
      this.logger.log('[PrismaService] Verificando backfill de slug para businesses...');
      const businessesWithoutSlug = await this.business.findMany({
        where: { slug: null },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      });

      if (businessesWithoutSlug.length === 0) {
        this.logger.log('[PrismaService] ✓ Todos los negocios ya tienen slug asignado.');
        return;
      }

      let updatedCount = 0;
      for (const b of businessesWithoutSlug) {
        const uniqueSlug = await this.generateUniqueSlug(b.name, b.id);
        await this.business.update({
          where: { id: b.id },
          data: { slug: uniqueSlug },
        });
        updatedCount++;
      }

      this.logger.log(`[PrismaService] ✓ Backfill de slug completado: ${updatedCount} negocio(s) actualizados.`);
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en backfill de slug: ${err.message}`);
    }
  }

  private async generateUniqueSlug(name: string, businessId: string): Promise<string> {
    const baseSlug = slugify(name);
    let candidate = baseSlug;
    let suffix = 2;

    while (true) {
      const existing = await this.business.findFirst({
        where: {
          slug: candidate,
          id: { not: businessId },
        },
        select: { id: true },
      });

      if (!existing) {
        return candidate;
      }

      candidate = `${baseSlug}-${suffix}`;
      suffix++;
    }
  }

  private async ensureServicesMigrated() {
    try {
      this.logger.log('[PrismaService] Verificando migración de BookingService a Service/ServiceSpecialist...');

      const tableCheck: any = await this.$queryRawUnsafe(`
        SELECT 1 FROM information_schema.tables WHERE table_name = 'booking_services'
      `);
      if (!tableCheck || tableCheck.length === 0) {
        this.logger.log('[PrismaService] Tabla booking_services no existe, nada que migrar.');
        return;
      }

      const totalAppointmentsBefore = await this.appointment.count();

      const legacyServices: any[] = await this.$queryRawUnsafe(`
        SELECT * FROM "booking_services" ORDER BY "createdAt" ASC
      `);

      if (legacyServices.length === 0) {
        this.logger.log('[PrismaService] No hay servicios legacy en booking_services.');
        return;
      }

      const byBiz = new Map<string, Map<string, any[]>>();
      for (const s of legacyServices) {
        let bizMap = byBiz.get(s.businessId);
        if (!bizMap) {
          bizMap = new Map<string, any[]>();
          byBiz.set(s.businessId, bizMap);
        }
        const normName = s.name.trim().toLowerCase();
        const list = bizMap.get(normName) || [];
        list.push(s);
        bizMap.set(normName, list);
      }

      let servicesCreated = 0;
      let servicesMerged = 0;
      let specialistLinksCreated = 0;

      for (const [bizId, bizMap] of byBiz.entries()) {
        for (const [normName, group] of bizMap.entries()) {
          const primaryLegacy = group[0];
          const targetServiceId = primaryLegacy.id;

          const existingService = await this.service.findUnique({
            where: { id: targetServiceId },
          });

          if (!existingService) {
            await this.service.create({
              data: {
                id: targetServiceId,
                businessId: bizId,
                name: primaryLegacy.name,
                description: primaryLegacy.description,
                durationMinutes: primaryLegacy.durationMinutes,
                price: Number(primaryLegacy.price),
                active: primaryLegacy.isActive !== undefined ? primaryLegacy.isActive : true,
                hasCustomSchedule: primaryLegacy.hasCustomSchedule || false,
                createdAt: primaryLegacy.createdAt,
                updatedAt: primaryLegacy.updatedAt,
              },
            });
            servicesCreated++;
          }

          if (group.length > 1) {
            servicesMerged += (group.length - 1);
            this.logger.log(`[PrismaService] Fusión de ${group.length} servicios con nombre "${normName}" en servicio ${targetServiceId}`);
          }

          for (const s of group) {
            if (s.specialistId) {
              const existingLink = await this.serviceSpecialist.findUnique({
                where: {
                  serviceId_specialistId: {
                    serviceId: targetServiceId,
                    specialistId: s.specialistId,
                  },
                },
              });
              if (!existingLink) {
                await this.serviceSpecialist.create({
                  data: {
                    serviceId: targetServiceId,
                    specialistId: s.specialistId,
                  },
                });
                specialistLinksCreated++;
              }
            }

            if (s.specialistId) {
              await this.$executeRawUnsafe(`
                UPDATE "appointments"
                SET "specialistId" = COALESCE("specialistId", '${s.specialistId}'),
                    "serviceId" = '${targetServiceId}'
                WHERE "serviceId" = '${s.id}'
              `);
            } else {
              await this.$executeRawUnsafe(`
                UPDATE "appointments"
                SET "serviceId" = '${targetServiceId}'
                WHERE "serviceId" = '${s.id}'
              `);
            }

            if (s.id !== targetServiceId) {
              await this.$executeRawUnsafe(`
                UPDATE "availability_schedules"
                SET "serviceId" = '${targetServiceId}'
                WHERE "serviceId" = '${s.id}'
              `);
            }
          }
        }
      }

      await this.$executeRawUnsafe(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE c.conname = 'appointments_serviceId_fkey'
              AND c.confrelid = (SELECT oid FROM pg_class WHERE relname = 'booking_services')
          ) THEN
            ALTER TABLE "appointments" DROP CONSTRAINT "appointments_serviceId_fkey";
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'appointments_serviceId_fkey'
          ) THEN
            ALTER TABLE "appointments"
              ADD CONSTRAINT "appointments_serviceId_fkey"
              FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE c.conname = 'availability_schedules_serviceId_fkey'
              AND c.confrelid = (SELECT oid FROM pg_class WHERE relname = 'booking_services')
          ) THEN
            ALTER TABLE "availability_schedules" DROP CONSTRAINT "availability_schedules_serviceId_fkey";
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'availability_schedules_serviceId_fkey'
          ) THEN
            ALTER TABLE "availability_schedules"
              ADD CONSTRAINT "availability_schedules_serviceId_fkey"
              FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
        END $$;
      `);

      const totalAppointmentsAfter = await this.appointment.count();
      if (totalAppointmentsBefore !== totalAppointmentsAfter) {
        throw new Error(
          `¡ALERTA DE INTEGRIDAD! Total de citas antes (${totalAppointmentsBefore}) no coincide con después (${totalAppointmentsAfter})`
        );
      }

      this.logger.log(
        `[PrismaService] ✓ Migración a Service/ServiceSpecialist completada exitosamente. ` +
        `Servicios: ${servicesCreated} creados, ${servicesMerged} fusionados. ` +
        `Especialistas asociados: ${specialistLinksCreated}. Total citas verificadas: ${totalAppointmentsAfter}/${totalAppointmentsBefore}.`
      );
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en migración de servicios: ${err.message}`);
    }
  }

  async ensureProfessionsMigrated() {
    try {
      this.logger.log('[PrismaService] Verificando migración de especialidades de texto libre a Profession...');

      const specialistsWithoutProfession = await this.specialist.findMany({
        where: {
          professionId: null,
          specialty: {
            not: null,
          },
        },
      });

      if (specialistsWithoutProfession.length === 0) {
        this.logger.log('[PrismaService] ✓ Todas las profesiones ya están sincronizadas.');
        return;
      }

      let professionsCreated = 0;
      let specialistsLinked = 0;

      for (const spec of specialistsWithoutProfession) {
        const rawSpecialty = (spec.specialty || '').trim();
        if (!rawSpecialty) continue;

        const professionName = rawSpecialty.length > 60 ? rawSpecialty.slice(0, 60).trim() : rawSpecialty;

        let profession = await this.profession.findFirst({
          where: {
            businessId: spec.businessId,
            name: {
              equals: professionName,
              mode: 'insensitive',
            },
          },
        });

        if (!profession) {
          profession = await this.profession.create({
            data: {
              businessId: spec.businessId,
              name: professionName,
              active: true,
            },
          });
          professionsCreated++;
        }

        await this.specialist.update({
          where: { id: spec.id },
          data: { professionId: profession.id },
        });
        specialistsLinked++;
      }

      this.logger.log(
        `[PrismaService] ✓ Migración a Profession completada. Profesiones creadas: ${professionsCreated}, Especialistas vinculados: ${specialistsLinked}.`
      );
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en migración de profesiones: ${err.message}`);
    }
  }

  private async ensureIndustriesAndFieldTemplatesSeeded() {
    try {
      this.logger.log('[103a Seed] Verificando seed de Industrias y Plantillas de Campos...');

      const industriesSeed = [
        {
          code: 'general',
          name: 'General',
          posVertical: PosVertical.RETAIL,
          order: 1,
          fields: [] as any[],
        },
        {
          code: 'restaurante',
          name: 'Restaurante / Cafetería',
          posVertical: PosVertical.RESTAURANTE,
          order: 2,
          fields: [] as any[],
        },
        {
          code: 'abarrotes',
          name: 'Abarrotería / Pulpería',
          posVertical: PosVertical.RETAIL,
          order: 3,
          fields: [
            { key: 'marca', label: 'Marca', dataType: ProductFieldDataType.TEXT, order: 1 },
            { key: 'contenido', label: 'Contenido', dataType: ProductFieldDataType.TEXT, order: 2 },
            {
              key: 'unidad',
              label: 'Unidad',
              dataType: ProductFieldDataType.SELECT,
              options: ['unidad', 'libra', 'kg', 'caja', 'docena', 'metro', 'litro'],
              order: 3,
            },
          ],
        },
        {
          code: 'farmacia',
          name: 'Farmacia',
          posVertical: PosVertical.RETAIL,
          order: 4,
          fields: [
            { key: 'laboratorio', label: 'Laboratorio', dataType: ProductFieldDataType.TEXT, order: 1 },
            { key: 'principio_activo', label: 'Principio activo', dataType: ProductFieldDataType.TEXT, searchable: true, order: 2 },
            { key: 'presentacion', label: 'Presentación', dataType: ProductFieldDataType.TEXT, order: 3 },
            { key: 'requiere_receta', label: 'Requiere receta', dataType: ProductFieldDataType.BOOLEAN, showInPos: true, order: 4 },
          ],
        },
        {
          code: 'ferreteria',
          name: 'Ferretería',
          posVertical: PosVertical.RETAIL,
          order: 5,
          fields: [
            { key: 'marca', label: 'Marca', dataType: ProductFieldDataType.TEXT, order: 1 },
            { key: 'medida', label: 'Medida', dataType: ProductFieldDataType.TEXT, order: 2 },
            {
              key: 'unidad',
              label: 'Unidad',
              dataType: ProductFieldDataType.SELECT,
              options: ['unidad', 'libra', 'kg', 'caja', 'docena', 'metro', 'litro'],
              order: 3,
            },
          ],
        },
        {
          code: 'cosmetica',
          name: 'Cosmetiquería',
          posVertical: PosVertical.RETAIL,
          order: 6,
          fields: [
            { key: 'marca', label: 'Marca', dataType: ProductFieldDataType.TEXT, order: 1 },
            { key: 'linea', label: 'Línea', dataType: ProductFieldDataType.TEXT, order: 2 },
            { key: 'tono_color', label: 'Tono / Color', dataType: ProductFieldDataType.TEXT, order: 3 },
            { key: 'contenido', label: 'Contenido', dataType: ProductFieldDataType.TEXT, order: 4 },
          ],
        },
        {
          code: 'ropa_calzado',
          name: 'Ropa y calzado',
          posVertical: PosVertical.RETAIL,
          order: 7,
          fields: [
            { key: 'marca', label: 'Marca', dataType: ProductFieldDataType.TEXT, order: 1 },
            {
              key: 'talla',
              label: 'Talla',
              dataType: ProductFieldDataType.SELECT,
              options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
              order: 2,
            },
            { key: 'color', label: 'Color', dataType: ProductFieldDataType.TEXT, order: 3 },
            {
              key: 'genero',
              label: 'Género',
              dataType: ProductFieldDataType.SELECT,
              options: ['Hombre', 'Mujer', 'Unisex', 'Niño', 'Niña'],
              order: 4,
            },
            { key: 'temporada', label: 'Temporada', dataType: ProductFieldDataType.TEXT, order: 5 },
          ],
        },
        {
          code: 'taller',
          name: 'Taller / Servicios automotrices (POS: Taller)',
          posVertical: PosVertical.RETAIL,
          order: 8,
          fields: [] as any[],
        },
      ];

      for (const item of industriesSeed) {
        const industry = await (this as any).industry.upsert({
          where: { code: item.code },
          update: {
            name: item.name,
            posVertical: item.posVertical,
            order: item.order,
          },
          create: {
            code: item.code,
            name: item.name,
            posVertical: item.posVertical,
            order: item.order,
          },
        });

        for (const field of item.fields) {
          await (this as any).industryFieldTemplate.upsert({
            where: {
              industryId_key: {
                industryId: industry.id,
                key: field.key,
              },
            },
            update: {
              label: field.label,
              dataType: field.dataType,
              required: field.required ?? false,
              options: field.options ?? null,
              order: field.order ?? 0,
              searchable: field.searchable ?? false,
              showInPos: field.showInPos ?? false,
            },
            create: {
              industryId: industry.id,
              key: field.key,
              label: field.label,
              dataType: field.dataType,
              required: field.required ?? false,
              options: field.options ?? null,
              order: field.order ?? 0,
              searchable: field.searchable ?? false,
              showInPos: field.showInPos ?? false,
            },
          });
        }
      }

      this.logger.log('[103a Seed] ✓ Seed de Industrias y Plantillas de Campos verificado y sincronizado.');
    } catch (err: any) {
      this.logger.warn(`[103a Seed] ⚠ Advertencia en seed de industrias: ${err.message}`);
    }
  }

  private async ensureBusinessesMigratedToIndustries() {
    try {
      this.logger.log('[103a Migration] Verificando asignación de Industry a negocios existentes...');

      // Reportar los valores distintos de la columna libre businesses.type
      const typesResult: any[] = await this.$queryRawUnsafe(`SELECT DISTINCT "type" FROM "businesses";`);
      const distinctTypes = typesResult.map((r: any) => r.type);
      this.logger.log(`[103a Migration] Valores distintos en columna businesses.type: ${JSON.stringify(distinctTypes)}`);

      const generalIndustry = await (this as any).industry.findUnique({ where: { code: 'general' } });
      const restauranteIndustry = await (this as any).industry.findUnique({ where: { code: 'restaurante' } });

      if (!generalIndustry || !restauranteIndustry) {
        this.logger.warn('[103a Migration] Industrias base general/restaurante no encontradas para migración.');
        return;
      }

      const unassigned = await (this as any).business.findMany({
        where: { industryId: null },
        select: { id: true, name: true, posVertical: true },
      });

      for (const b of unassigned) {
        const targetIndustryId = b.posVertical === PosVertical.RESTAURANTE ? restauranteIndustry.id : generalIndustry.id;
        await (this as any).business.update({
          where: { id: b.id },
          data: { industryId: targetIndustryId },
        });
        this.logger.log(
          `[103a Migration] Negocio '${b.name}' (${b.id}) vinculado a industria '${b.posVertical === PosVertical.RESTAURANTE ? 'restaurante' : 'general'}'.`,
        );
      }

      // Asegurar que attributes en pos_products no sea NULL
      await this.$executeRawUnsafe(`UPDATE "pos_products" SET "attributes" = '{}' WHERE "attributes" IS NULL;`);
      this.logger.log('[103a Migration] ✓ Migración de negocios existentes a industrias completada.');
    } catch (err: any) {
      this.logger.warn(`[103a Migration] ⚠ Advertencia en migración de negocios a industrias: ${err.message}`);
    }
  }

  private async ensureTaxConfigurationBackfilled() {
    try {
      this.logger.log('[PrismaService] Verificando backfill de configuración de impuestos en negocios...');
      
      const unconfiguredBusinesses = await this.business.findMany({
        where: { taxConfiguredAt: null },
        select: { id: true, name: true, taxRate: true, taxEnabled: true, taxIncluded: true }
      });

      if (unconfiguredBusinesses.length === 0) {
        this.logger.log('[PrismaService] ✓ Todos los negocios ya tienen su configuración de impuestos definida explícitamente.');
        return;
      }

      let updatedCount = 0;
      for (const b of unconfiguredBusinesses) {
        // Regla: si taxRate > 0, entonces taxEnabled = true; si taxRate = 0, taxEnabled = false
        // taxIncluded debe ser false para preservar compatibilidad con como funcionaba antes (sumaba encima).
        const shouldBeEnabled = b.taxRate > 0;
        
        await this.business.update({
          where: { id: b.id },
          data: {
            taxEnabled: shouldBeEnabled,
            taxIncluded: false,
            taxConfiguredAt: new Date()
          }
        });
        
        this.logger.log(
          `[PrismaService] ✓ Backfill impuestos: Negocio "${b.name}" (${b.id}) -> Rate: ${b.taxRate}%, Enabled: ${shouldBeEnabled}, Included: false`
        );
        updatedCount++;
      }
      this.logger.log(`[PrismaService] ✓ Backfill de configuración de impuestos completado: ${updatedCount} negocio(s) actualizados.`);
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en backfill de impuestos: ${err.message}`);
    }
  }

  private async ensurePosPoliciesBackfilled() {
    this.logger.log(`[PrismaService] Verificando backfill de políticas POS en negocios...`);
    try {
      const businessesWithoutPolicies = await this.business.findMany({
        where: {
          posPolicies: {
            is: null
          }
        },
        select: { id: true }
      });

      if (businessesWithoutPolicies.length === 0) {
        this.logger.log(`[PrismaService] ✓ Todos los negocios ya tienen sus políticas POS definidas.`);
        return;
      }

      let updatedCount = 0;
      for (const b of businessesWithoutPolicies) {
        try {
          await this.posPolicies.create({
            data: {
              businessId: b.id,
              returnsEnabled: true,
              returnsRequireApproval: true,
              returnsMaxDays: 30,
              voidsCompletedEnabled: true,
              voidsRequireApproval: true,
              discountsEnabled: true,
              cashierMaxDiscountPercent: 10,
              priceOverrideEnabled: false,
              paymentMethodsEnabled: "EFECTIVO,TARJETA,TRANSFERENCIA,CREDITO,OTRO",
              requireReferenceCard: true,
              requireReferenceTransfer: true,
              requireReferenceOther: false,
              multiCurrencyEnabled: false,
              acceptedCurrencies: "NIO",
              blindCashClose: true,
              cashDifferenceTolerance: 0,
              noSaleDrawerOpenAllowed: true,
              allowNegativeStock: false,
              inventoryAdjustRequireApproval: true
            }
          });
          updatedCount++;
        } catch (e) {
          this.logger.warn(`[PrismaService] No se pudo crear posPolicies para ${b.id}: ${e.message}`);
        }
      }
      this.logger.log(`[PrismaService] ✓ Backfill de políticas POS completado: ${updatedCount} negocio(s) actualizados.`);
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en backfill de políticas POS: ${err.message}`);
    }
  }

  private async ensurePosPaymentsBackfilled() {
    this.logger.log(`[PrismaService] Verificando backfill de pagos POS en ventas existentes...`);
    try {
      // Find sales without payments
      const salesWithoutPayments = await this.sale.findMany({
        where: { payments: { none: {} } },
        select: {
          id: true,
          amountPaid: true,
          change: true,
          paymentMethod: true,
          reference: true,
          cashRegisterId: true,
          cashierId: true,
          business: { select: { currency: true } }
        }
      });

      if (salesWithoutPayments.length === 0) {
        this.logger.log(`[PrismaService] ✓ Todas las ventas existentes ya tienen sus pagos migrados a pos_payments.`);
        return;
      }

      let updatedCount = 0;
      for (const sale of salesWithoutPayments) {
        try {
          const amountPaid = Number(sale.amountPaid);
          const change = Number(sale.change);
          await this.posPayment.create({
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
        } catch (e) {
          this.logger.warn(`[PrismaService] No se pudo crear posPayment para la venta ${sale.id}: ${e.message}`);
        }
      }
      this.logger.log(`[PrismaService] ✓ Backfill de pagos POS completado: ${updatedCount} venta(s) actualizadas.`);
    } catch (err: any) {
      this.logger.warn(`[PrismaService] ⚠ Advertencia en backfill de pagos POS: ${err.message}`);
    }
  }

  private async ensureSalonZonesBackfilled(): Promise<void> {
    try {
      const businessesWithTablesWithoutZone = await this.$queryRaw<Array<{ businessId: string }>>`
        SELECT DISTINCT "businessId"
        FROM "pos_restaurant_tables"
        WHERE "zoneId" IS NULL
      `;

      if (!businessesWithTablesWithoutZone || businessesWithTablesWithoutZone.length === 0) {
        return;
      }

      this.logger.log(
        `[PrismaService] Migrando mesas existentes a 'Salón principal' para ${businessesWithTablesWithoutZone.length} negocio(s)...`,
      );

      for (const row of businessesWithTablesWithoutZone) {
        const businessId = row.businessId;

        const mainZone = await this.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "pos_salon_zones"
          WHERE "businessId" = ${businessId} AND LOWER("name") = LOWER('Salón principal') AND "isActive" = true
          LIMIT 1
        `;

        let zoneId: string;
        if (mainZone && mainZone.length > 0) {
          zoneId = mainZone[0].id;
        } else {
          const newZoneId = randomUUID();
          await this.$executeRawUnsafe(
            `INSERT INTO "pos_salon_zones" ("id", "businessId", "name", "sortOrder", "isActive", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, true, NOW(), NOW())`,
            newZoneId,
            businessId,
            'Salón principal',
            0,
          );
          zoneId = newZoneId;
        }

        const updated = await this.$executeRawUnsafe(
          `UPDATE "pos_restaurant_tables"
           SET "zoneId" = $1, "updatedAt" = NOW()
           WHERE "businessId" = $2 AND "zoneId" IS NULL`,
          zoneId,
          businessId,
        );

        this.logger.log(
          `[PrismaService] Negocio ${businessId}: ${updated} mesa(s) asignadas a zona 'Salón principal' (${zoneId}).`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`[PrismaService] Advertencia en ensureSalonZonesBackfilled: ${err.message}`);
    }
  }
}
