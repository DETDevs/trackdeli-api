import { Module } from '@nestjs/common';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, SalesModule, AuditModule],
  controllers: [TablesController],
  providers: [TablesService],
  exports: [TablesService],
})
export class TablesModule {}
