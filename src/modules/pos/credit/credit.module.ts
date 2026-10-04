import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { TrackingModule } from '../../tracking/tracking.module';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';
import { PosPermissionsModule } from '../permissions/permissions.module';
import { PoliciesModule } from '../policies/policies.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, TrackingModule, PosPermissionsModule, PoliciesModule, AuditModule],
  controllers: [CreditController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
