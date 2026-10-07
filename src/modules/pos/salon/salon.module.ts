import { Module } from '@nestjs/common';
import { SalonZonesController } from './salon-zones.controller';
import { SalonZonesService } from './salon-zones.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [SalonZonesController],
  providers: [SalonZonesService],
  exports: [SalonZonesService],
})
export class SalonModule {}
