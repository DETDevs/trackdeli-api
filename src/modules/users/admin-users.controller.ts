import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SkipMembershipCheck } from '../../common/decorators/skip-membership.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { AdminUsersService } from './admin-users.service';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { AdminResetPasswordDto } from './dto/admin-reset-password.dto';
import { AdminUpdateStatusDto } from './dto/admin-update-status.dto';
import { AdminListUsersQueryDto } from './dto/admin-list-users-query.dto';

@SkipMembershipCheck()
@Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Post()
  createUser(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AdminCreateUserDto,
  ) {
    return this.service.createUser(user, dto);
  }

  @Get()
  listUsers(
    @CurrentUser() user: JwtPayload,
    @Query() query: AdminListUsersQueryDto,
  ) {
    return this.service.listUsers(user, query);
  }

  @Patch(':id/password')
  resetPassword(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AdminResetPasswordDto,
  ) {
    return this.service.resetPassword(user, id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AdminUpdateStatusDto,
  ) {
    return this.service.updateStatus(user, id, dto);
  }
}
