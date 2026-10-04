import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PoliciesModule } from '../policies/policies.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { PosPermissionsModule } from '../permissions/permissions.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [
    PrismaModule,
    PoliciesModule,
    ApprovalsModule,
    AuditModule,
    PosPermissionsModule,
    IdempotencyModule,
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
