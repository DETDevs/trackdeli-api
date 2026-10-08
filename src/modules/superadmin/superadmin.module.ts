import { Module } from '@nestjs/common';
import { SuperAdminController } from './superadmin.controller';
import { SuperAdminService } from './superadmin.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { BusinessesModule } from '../businesses/businesses.module';
import { LatencyDiagnosticsService } from './latency-diagnostics.service';
import { ClientVersionModule } from '../client-version/client-version.module';
import { AuditModule } from '../pos/audit/audit.module';

@Module({
  imports: [PrismaModule, UploadModule, CommissionsModule, BusinessesModule, ClientVersionModule, AuditModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService, LatencyDiagnosticsService],
  exports: [SuperAdminService],
})
export class SuperAdminModule {}
