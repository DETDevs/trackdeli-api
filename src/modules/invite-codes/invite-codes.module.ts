import { Module } from '@nestjs/common';
import { InviteCodesController } from './invite-codes.controller';
import { InviteCodesService } from './invite-codes.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [InviteCodesController],
  providers: [InviteCodesService],
  exports: [InviteCodesService],
})
export class InviteCodesModule {}
