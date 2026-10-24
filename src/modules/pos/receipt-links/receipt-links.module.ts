import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../prisma/prisma.module';
import { UploadModule } from '../../upload/upload.module';
import { PublicReceiptsController } from './public-receipts.controller';
import { ReceiptLinksController } from './receipt-links.controller';
import { ReceiptLinksService } from './receipt-links.service';

@Module({
  imports: [PrismaModule, UploadModule, ConfigModule],
  controllers: [ReceiptLinksController, PublicReceiptsController],
  providers: [ReceiptLinksService],
  exports: [ReceiptLinksService],
})
export class ReceiptLinksModule {}
