import { Module } from '@nestjs/common';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';

@Module({
  imports: [PrismaModule, SalesModule],
  controllers: [TablesController],
  providers: [TablesService],
  exports: [TablesService],
})
export class TablesModule {}
