import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { UnitsService } from './units.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/units')
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN, UserRole.WAITER, UserRole.VENDEDOR)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('includeInactive') includeInactive?: string,
    @Query('businessId') qBid?: string,
  ) {
    const wantInactive = includeInactive === 'true' || includeInactive === '1';
    return this.unitsService.findAll(resolveBusinessId(user, qBid), wantInactive, user.role);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUnitDto,
    @Query('businessId') qBid?: string,
  ) {
    return this.unitsService.create(resolveBusinessId(user, qBid), dto);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateUnitDto,
    @Query('businessId') qBid?: string,
  ) {
    return this.unitsService.update(resolveBusinessId(user, qBid), id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('businessId') qBid?: string,
  ) {
    return this.unitsService.remove(resolveBusinessId(user, qBid), id);
  }
}
