import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { IndustriesService } from './industries.service';
import { IndustriesController } from './industries.controller';
import { SuperAdminIndustriesController } from './superadmin-industries.controller';

@Module({
  imports: [PrismaModule],
  controllers: [IndustriesController, SuperAdminIndustriesController],
  providers: [IndustriesService],
  exports: [IndustriesService],
})
export class IndustriesModule {}
