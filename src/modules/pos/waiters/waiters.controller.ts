import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../../../common/decorators/public.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { WaitersService } from './waiters.service';
import { WaiterLoginDto } from './dto/waiter-login.dto';
import { CreateWaiterDto } from './dto/create-waiter.dto';
import { UpdateWaiterDto } from './dto/update-waiter.dto';

@SkipMembershipCheck()
@Controller()
export class WaitersController {
  constructor(private readonly service: WaitersService) {}

  /**
   * Selector público de meseros por negocio (slug o ID).
   * Solo devuelve id y name de meseros activos, sin datos sensibles.
   */
  @Public()
  @Get(['businesses/:slugOrId/waiters', 'pos/businesses/:slugOrId/waiters'])
  getPublicWaiters(@Param('slugOrId') slugOrId: string) {
    return this.service.getPublicWaiters(slugOrId);
  }

  /**
   * Inicio de sesión público por PIN de 4 dígitos.
   */
  @Public()
  @Post(['businesses/:slugOrId/waiters/login', 'pos/businesses/:slugOrId/waiters/login'])
  @HttpCode(HttpStatus.OK)
  loginWithPin(
    @Param('slugOrId') slugOrId: string,
    @Body() dto: WaiterLoginDto,
  ) {
    return this.service.loginWithPin(slugOrId, dto);
  }

  /**
   * Endpoints de administración de meseros (ENCARGADO y SUPERADMIN)
   */
  @UseGuards(JwtAuthGuard, PosGuard)
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @Get('pos/waiters')
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findAll(resolveBusinessId(user, qBid));
  }

  @UseGuards(JwtAuthGuard, PosGuard)
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @Get('pos/waiters/:id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findOne(resolveBusinessId(user, qBid), id);
  }

  @UseGuards(JwtAuthGuard, PosGuard)
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @Post('pos/waiters')
  create(
    @Body() dto: CreateWaiterDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.create(resolveBusinessId(user, qBid), dto);
  }

  @UseGuards(JwtAuthGuard, PosGuard)
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @Patch('pos/waiters/:id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWaiterDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.update(resolveBusinessId(user, qBid), id, dto);
  }

  @UseGuards(JwtAuthGuard, PosGuard)
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @Delete('pos/waiters/:id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.remove(resolveBusinessId(user, qBid), id);
  }
}
