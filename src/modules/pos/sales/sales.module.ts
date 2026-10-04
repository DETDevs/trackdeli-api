import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PoliciesModule } from '../policies/policies.module';
import { PosPermissionsModule } from '../permissions/permissions.module';
import { AuditModule } from '../audit/audit.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ApprovalsModule } from '../approvals/approvals.module';

import { ReturnsController } from './returns.controller';

@Module({
  imports: [PrismaModule, PoliciesModule, PosPermissionsModule, AuditModule, ExchangeRateModule, ApprovalsModule],
  controllers: [SalesController, ReturnsController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
