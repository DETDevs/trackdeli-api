import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BackofficeController } from './backoffice.controller';
import { BackofficeService } from './backoffice.service';
import { BackofficeGuard } from './backoffice.guard';
import { ReportsModule } from '../reports/reports.module';
import { BatchesModule } from '../batches/batches.module';

@Module({
  imports: [PrismaModule, ReportsModule, BatchesModule],
  controllers: [BackofficeController],
  providers: [BackofficeService, BackofficeGuard],
  exports: [BackofficeService],
})
export class BackofficeModule {}
