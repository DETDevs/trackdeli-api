import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ForbiddenException } from '@nestjs/common';
import { PosUsersService } from './pos-users.service';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { resolveBusinessId } from '../pos.utils';
import { SetUserPinDto } from './dto/set-user-pin.dto';

@Controller('pos/users')
@UseGuards(RolesGuard)
export class PosUsersController {
  constructor(private readonly posUsersService: PosUsersService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.CAJERO)
  async getBusinessUsers(@CurrentUser() user: JwtPayload, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    const users = await this.posUsersService.getUsers(businessId);
    if (user.role === UserRole.CAJERO) {
      return (users.users || []).filter((u: any) => u.role === UserRole.VENDEDOR && u.isActive);
    }
    return users;
  }

  @Post()
  async createBusinessUser(@CurrentUser() user: JwtPayload, @Body() dto: any, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    return this.posUsersService.createUser(businessId, dto, user.sub);
  }

  @Patch(':id/pin')
  async setUserPin(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SetUserPinDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.posUsersService.setUserPin(businessId, id, dto.pin, user.sub);
  }

  @Patch(':id')
  async updateBusinessUser(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.posUsersService.updateUser(businessId, id, dto, user.sub);
  }

  @Patch(':id/deactivate')
  async deactivateUser(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    return this.posUsersService.deactivateUser(businessId, id, user.sub);
  }

  @Patch(':id/activate')
  async activateUser(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    return this.posUsersService.activateUser(businessId, id, user.sub);
  }

  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query('businessId') qBid?: string) {
    const businessId = resolveBusinessId(user, qBid);
    return this.posUsersService.resetPassword(businessId, id, user.sub);
  }
}
