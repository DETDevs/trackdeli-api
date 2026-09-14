import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { TrackingModule } from '../../tracking/tracking.module';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';

@Module({
  imports: [PrismaModule, TrackingModule],
  controllers: [CreditController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
