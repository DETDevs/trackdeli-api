import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BatchesModule } from '../batches/batches.module';
import { PoliciesModule } from '../policies/policies.module';
import { PosQuotesController } from './pos-quotes.controller';
import { PosQuotesService } from './pos-quotes.service';

@Module({
  imports: [PrismaModule, PoliciesModule, ApprovalsModule, BatchesModule],
  controllers: [PosQuotesController],
  providers: [PosQuotesService],
  exports: [PosQuotesService],
})
export class PosQuotesModule {}

