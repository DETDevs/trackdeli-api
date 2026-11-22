import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { MobileDeviceGuard } from './guards/mobile-device.guard';

@Global()
@Module({
  imports: [PrismaModule, BusinessProductsModule],
  controllers: [PushController],
  providers: [PushService, MobileDeviceGuard],
  exports: [PushService],
})
export class PushModule {}
