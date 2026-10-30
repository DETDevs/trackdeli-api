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
import { RolesGuard } from '../../../common/guards/roles.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { resolveBusinessId } from '../pos.utils';
import { BanksService } from './banks.service';
import { CreateBankDto } from './dto/create-bank.dto';
import { UpdateBankDto } from './dto/update-bank.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, RolesGuard)
@Controller(['pos/banks', 'businesses/me/banks'])
export class BanksController {
  constructor(private readonly service: BanksService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.VENDEDOR)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('includeInactive') includeInactive?: string | boolean,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    const allowInactive =
      (user.role === UserRole.ENCARGADO || user.role === UserRole.SUPERADMIN) &&
      (includeInactive === 'true' || includeInactive === true || includeInactive === '1');
    return this.service.findAll(businessId, allowInactive);
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.VENDEDOR)
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.findOne(id, businessId);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreateBankDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.create(businessId, dto, user.sub, user.role);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBankDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.update(id, businessId, dto, user.sub, user.role);
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.remove(id, businessId, user.sub, user.role);
  }
}
