import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';
import { AuditModule } from '../audit/audit.module';
import { BatchesModule } from '../batches/batches.module';
import { ReportsModule } from '../reports/reports.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PushSchedulerService } from './push-scheduler.service';
import { MobileDeviceGuard } from './guards/mobile-device.guard';

@Global()
@Module({
  imports: [
    PrismaModule,
    BusinessProductsModule,
    AuditModule,
    BatchesModule,
    ReportsModule,
  ],
  controllers: [PushController],
  providers: [PushService, PushSchedulerService, MobileDeviceGuard],
  exports: [PushService, PushSchedulerService],
})
export class PushModule {}
