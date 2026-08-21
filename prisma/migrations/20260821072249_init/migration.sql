-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ENCARGADO', 'REPARTIDOR', 'SUPERADMIN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDIENTE', 'TOMADO', 'EN_CAMINO', 'CERCA_DEL_DESTINO', 'VERIFICANDO_ENTREGA', 'ENTREGADO', 'CANCELADO', 'INCIDENCIA', 'CERRADO');

-- CreateEnum
CREATE TYPE "DeliveryPaymentStatus" AS ENUM ('PAGADO', 'CONTRA_ENTREGA', 'GRATIS');

-- CreateEnum
CREATE TYPE "OrderPhotoType" AS ENUM ('ARMADO', 'ENTREGA');

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" VARCHAR(50),
    "logoUrl" VARCHAR(500),
    "defaultGeofenceRadiusM" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(20),
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "deliveryUserId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDIENTE',
    "customerName" VARCHAR(100) NOT NULL,
    "customerPhone" VARCHAR(20) NOT NULL,
    "destinationAddress" VARCHAR(300),
    "destinationLat" DECIMAL(10,7),
    "destinationLng" DECIMAL(10,7),
    "geofenceRadiusM" INTEGER NOT NULL DEFAULT 100,
    "description" TEXT,
    "deliveryPaymentStatus" "DeliveryPaymentStatus" NOT NULL DEFAULT 'GRATIS',
    "deliveryFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deliveryConfirmationUrl" VARCHAR(500),
    "signatureUrl" VARCHAR(500),
    "takenAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_photos" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "photoUrl" VARCHAR(500) NOT NULL,
    "type" "OrderPhotoType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_sessions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_snapshots" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lat" DECIMAL(10,7) NOT NULL,
    "lng" DECIMAL(10,7) NOT NULL,
    "speed" DECIMAL(5,2),
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stars" SMALLINT NOT NULL,
    "comment" TEXT,
    "tipAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(200),
    "body" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_sessions_orderId_key" ON "tracking_sessions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_sessions_token_key" ON "tracking_sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_orderId_key" ON "ratings"("orderId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_deliveryUserId_fkey" FOREIGN KEY ("deliveryUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_photos" ADD CONSTRAINT "order_photos_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_snapshots" ADD CONSTRAINT "location_snapshots_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_snapshots" ADD CONSTRAINT "location_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
