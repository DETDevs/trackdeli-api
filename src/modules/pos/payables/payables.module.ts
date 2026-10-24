import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PosPermissionsModule } from '../permissions/permissions.module';
import { PoliciesModule } from '../policies/policies.module';
import { PayablesController } from './payables.controller';
import { PayablesService } from './payables.service';

@Module({
  imports: [PrismaModule, AuditModule, PosPermissionsModule, PoliciesModule],
  controllers: [PayablesController],
  providers: [PayablesService],
  exports: [PayablesService],
})
export class PayablesModule {}
