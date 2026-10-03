import { Controller, Get, Post, Patch, Param, Body, UseGuards, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { PosUsersService } from './pos-users.service';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { RolesGuard } from '../../../common/guards/roles.guard';

@Controller('pos/users')
@UseGuards(RolesGuard)
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
export class PosUsersController {
  constructor(private readonly posUsersService: PosUsersService) {}

  @Get()
  async getBusinessUsers(@CurrentUser() user: JwtPayload) {
    if (!user.businessId) throw new ForbiddenException('No pertenece a ningún negocio');
    return this.posUsersService.getUsers(user.businessId);
  }

  @Post()
  async createBusinessUser(@CurrentUser() user: JwtPayload, @Body() dto: any) {
    if (!user.businessId) throw new ForbiddenException('No pertenece a ningún negocio');
    return this.posUsersService.createUser(user.businessId, dto, user.sub);
  }

  @Patch(':id')
  async updateBusinessUser(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: any) {
    if (!user.businessId) throw new ForbiddenException('No pertenece a ningún negocio');
    return this.posUsersService.updateUser(user.businessId, id, dto, user.sub);
  }

  @Patch(':id/deactivate')
  async deactivateUser(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!user.businessId) throw new ForbiddenException('No pertenece a ningún negocio');
    return this.posUsersService.deactivateUser(user.businessId, id, user.sub);
  }

  @Patch(':id/activate')
  async activateUser(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!user.businessId) throw new ForbiddenException('No pertenece a ningún negocio');
    return this.posUsersService.activateUser(user.businessId, id, user.sub);
  }

  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!user.businessId) throw new ForbiddenException('No pertenece a ningún negocio');
    return this.posUsersService.resetPassword(user.businessId, id, user.sub);
  }
}
