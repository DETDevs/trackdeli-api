import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';
import { PosNotificationsCenterController } from './pos-notifications-center.controller';
import { PosNotificationsCenterService } from './pos-notifications-center.service';

@Module({
  imports: [PrismaModule, BusinessProductsModule],
  controllers: [PosNotificationsCenterController],
  providers: [PosNotificationsCenterService],
  exports: [PosNotificationsCenterService],
})
export class PosNotificationsCenterModule {}
