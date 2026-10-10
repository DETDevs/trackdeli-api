import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { SkipWebAdminAccess } from '../../../common/decorators/skip-web-admin-access.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { SalonZonesService } from './salon-zones.service';
import { CreateSalonZoneDto } from './dto/create-salon-zone.dto';
import { UpdateSalonZoneDto } from './dto/update-salon-zone.dto';
import { ReorderSalonZonesDto } from './dto/reorder-salon-zones.dto';

@SkipMembershipCheck()
@SkipWebAdminAccess()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/salon/zones')
export class SalonZonesController {
  constructor(private readonly service: SalonZonesService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, qBid));
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreateSalonZoneDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.create(resolveBusinessId(user, qBid), dto, user);
  }

  @Patch('reorder')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  reorder(
    @Body() dto: ReorderSalonZonesDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.reorder(resolveBusinessId(user, qBid), dto, user);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSalonZoneDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.update(resolveBusinessId(user, qBid), id, dto, user);
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  delete(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.delete(resolveBusinessId(user, qBid), id, user);
  }
}
