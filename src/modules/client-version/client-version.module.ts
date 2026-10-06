import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ClientVersionService } from './client-version.service';
import { ClientVersionGuard } from './client-version.guard';
import { ClientVersionController } from './client-version.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ClientVersionController],
  providers: [ClientVersionService, ClientVersionGuard],
  exports: [ClientVersionService, ClientVersionGuard],
})
export class ClientVersionModule {}
