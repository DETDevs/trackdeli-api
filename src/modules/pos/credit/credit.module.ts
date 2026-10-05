import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { TrackingModule } from '../../tracking/tracking.module';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';
import { PosPermissionsModule } from '../permissions/permissions.module';
import { PoliciesModule } from '../policies/policies.module';
import { AuditModule } from '../audit/audit.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';

@Module({
  imports: [PrismaModule, TrackingModule, PosPermissionsModule, PoliciesModule, AuditModule, IdempotencyModule],
  controllers: [CreditController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
