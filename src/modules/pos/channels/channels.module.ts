import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { PedidosYaSettlementController } from './pedidosya-settlement.controller';
import { PedidosYaSettlementService } from './pedidosya-settlement.service';

@Module({
  imports: [PrismaModule],
  controllers: [ChannelsController, PedidosYaSettlementController],
  providers: [ChannelsService, PedidosYaSettlementService],
  exports: [ChannelsService, PedidosYaSettlementService],
})
export class ChannelsModule {}
