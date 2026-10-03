import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminUsersController } from './admin-users.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { UserQuotaService } from './user-quota.service';

@Module({
  imports: [PrismaModule, UploadModule],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService, AdminUsersService, UserQuotaService],
  exports: [UsersService, AdminUsersService, UserQuotaService],
})
export class UsersModule {}

