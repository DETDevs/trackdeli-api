import { Module } from '@nestjs/common';
import { BusinessesService } from './businesses.service';
import { BusinessesController } from './businesses.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { ClientVersionModule } from '../client-version/client-version.module';

@Module({
  imports: [PrismaModule, ClientVersionModule],
  controllers: [BusinessesController],
  providers: [BusinessesService],
  exports: [BusinessesService],
})
export class BusinessesModule {}
