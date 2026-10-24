import { Module } from '@nestjs/common';
import { PrintAuditService } from './print-audit.service';
import { PrintAuditController } from './print-audit.controller';
import { ReceiptSettingsController } from './receipt-settings.controller';

@Module({
  controllers: [PrintAuditController, ReceiptSettingsController],
  providers: [PrintAuditService],
  exports: [PrintAuditService],
})
export class PrintAuditModule {}
