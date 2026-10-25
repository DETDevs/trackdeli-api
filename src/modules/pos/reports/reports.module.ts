import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BatchesModule } from '../batches/batches.module';

@Module({
  imports: [PrismaModule, BatchesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
