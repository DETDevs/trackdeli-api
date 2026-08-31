import { Module } from '@nestjs/common';
import { SuperAdminController } from './superadmin.controller';
import { SuperAdminService } from './superadmin.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { CommissionsModule } from '../commissions/commissions.module';
import { BusinessesModule } from '../businesses/businesses.module';

@Module({
  imports: [PrismaModule, UploadModule, CommissionsModule, BusinessesModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService],
  exports: [SuperAdminService],
})
export class SuperAdminModule {}
