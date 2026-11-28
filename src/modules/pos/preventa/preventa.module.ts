import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';
import { AuditModule } from '../audit/audit.module';
import { PushModule } from '../push/push.module';
import { PreventaController } from './preventa.controller';
import { PreventaService } from './preventa.service';
import { PreventaGuard } from './preventa.guard';

@Module({
  imports: [PrismaModule, BusinessProductsModule, AuditModule, PushModule],
  controllers: [PreventaController],
  providers: [PreventaService, PreventaGuard],
  exports: [PreventaService, PreventaGuard],
})
export class PreventaModule {}
