import { Module } from '@nestjs/common';
import { PosDevicesController } from './pos-devices.controller';
import { WebDevicesController } from './web-devices.controller';
import { PosDevicesService } from './pos-devices.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';

@Module({
  imports: [PrismaModule, AuditModule, BusinessProductsModule],
  controllers: [PosDevicesController, WebDevicesController],
  providers: [PosDevicesService],
  exports: [PosDevicesService],
})
export class PosDevicesModule {}
