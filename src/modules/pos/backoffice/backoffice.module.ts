import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BackofficeController } from './backoffice.controller';
import { BackofficeService } from './backoffice.service';
import { BackofficeGuard } from './backoffice.guard';

@Module({
  imports: [PrismaModule],
  controllers: [BackofficeController],
  providers: [BackofficeService, BackofficeGuard],
  exports: [BackofficeService],
})
export class BackofficeModule {}
