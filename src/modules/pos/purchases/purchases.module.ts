import { Module } from '@nestjs/common';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PoliciesModule } from '../policies/policies.module';
import { AuditModule } from '../audit/audit.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';
import { BatchesModule } from '../batches/batches.module';

@Module({
  imports: [
    PrismaModule,
    PoliciesModule,
    AuditModule,
    IdempotencyModule,
    BusinessProductsModule,
    BatchesModule,
  ],
  controllers: [PurchasesController],
  providers: [PurchasesService],
  exports: [PurchasesService],
})
export class PurchasesModule {}
