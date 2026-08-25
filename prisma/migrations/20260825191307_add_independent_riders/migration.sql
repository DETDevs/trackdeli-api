/*
  Warnings:

  - The values [TOMADO] on the enum `OrderStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('MOTO', 'BICICLETA', 'CARRO', 'A_PIE');

-- AlterEnum
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('PENDIENTE', 'ACEPTADO', 'EN_CAMINO_AL_NEGOCIO', 'EN_EL_NEGOCIO', 'EN_CAMINO', 'CERCA_DEL_DESTINO', 'VERIFICANDO_ENTREGA', 'ENTREGADO', 'CANCELADO', 'INCIDENCIA', 'CERRADO');
ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PENDIENTE';
COMMIT;

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_businessId_fkey";

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "arrivedAtBusinessAt" TIMESTAMP(3),
ADD COLUMN     "pickedUpAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "currentLatitude" DOUBLE PRECISION,
ADD COLUMN     "currentLongitude" DOUBLE PRECISION,
ADD COLUMN     "isAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastLocationAt" TIMESTAMP(3),
ADD COLUMN     "profilePhotoUrl" TEXT,
ADD COLUMN     "vehicleColor" TEXT,
ADD COLUMN     "vehiclePhotoUrl" TEXT,
ADD COLUMN     "vehiclePlate" TEXT,
ADD COLUMN     "vehicleType" "VehicleType",
ALTER COLUMN "businessId" DROP NOT NULL,
ALTER COLUMN "role" SET DEFAULT 'REPARTIDOR';

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
