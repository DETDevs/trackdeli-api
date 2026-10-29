import { Module } from '@nestjs/common';
import { PresaleTicketsController } from './presale-tickets.controller';
import { PresaleTicketsService } from './presale-tickets.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { PoliciesModule } from '../policies/policies.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, SalesModule, PoliciesModule, AuditModule],
  controllers: [PresaleTicketsController],
  providers: [PresaleTicketsService],
  exports: [PresaleTicketsService],
})
export class PresaleTicketsModule {}
