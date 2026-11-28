import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { SkipWebAdminAccess } from '../../../common/decorators/skip-web-admin-access.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { PreventaGuard } from './preventa.guard';
import { PreventaService } from './preventa.service';
import { CreateRouteSellerDto } from './dto/create-route-seller.dto';
import { UpdateRouteSellerDto } from './dto/update-route-seller.dto';
import { UpdatePreventaSettingsDto } from './dto/update-preventa-settings.dto';

/**
 * 320a — Módulo de Preventa (sin WebBillingGuard).
 */
@SkipMembershipCheck()
@SkipWebAdminAccess()
@UseGuards(JwtAuthGuard, PreventaGuard)
@Controller('pos/preventa')
export class PreventaController {
  constructor(private readonly service: PreventaService) {}

  @Get('sellers')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  listSellers(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.listSellers(resolveBusinessId(user, qBid));
  }

  @Post('sellers')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  createSeller(
    @Body() dto: CreateRouteSellerDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.createSeller(resolveBusinessId(user, qBid), dto, user);
  }

  @Patch('sellers/:id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  updateSeller(
    @Param('id') id: string,
    @Body() dto: UpdateRouteSellerDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateSeller(resolveBusinessId(user, qBid), id, dto, user);
  }

  @Get('settings')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN, UserRole.PREVENTISTA)
  getSettings(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getSettings(resolveBusinessId(user, qBid), user.role);
  }

  @Patch('settings')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @HttpCode(HttpStatus.OK)
  updateSettings(
    @Body() dto: UpdatePreventaSettingsDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateSettings(resolveBusinessId(user, qBid), dto, user);
  }
}
