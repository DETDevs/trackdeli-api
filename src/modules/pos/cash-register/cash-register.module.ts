import { Module } from '@nestjs/common';
import { CashRegisterController } from './cash-register.controller';
import { CashRegisterService } from './cash-register.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PoliciesModule } from '../policies/policies.module';
import { AuditModule } from '../audit/audit.module';
import { PosPermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [PrismaModule, PoliciesModule, AuditModule, PosPermissionsModule],
  controllers: [CashRegisterController],
  providers: [CashRegisterService],
  exports: [CashRegisterService],
})
export class CashRegisterModule {}
