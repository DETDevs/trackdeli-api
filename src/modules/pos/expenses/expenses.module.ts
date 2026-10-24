import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PosPermissionsModule } from '../permissions/permissions.module';
import { PoliciesModule } from '../policies/policies.module';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [PrismaModule, AuditModule, PosPermissionsModule, PoliciesModule],
  controllers: [ExpensesController],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
