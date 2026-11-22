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
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { PromotionsService } from './promotions.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/promotions')
export class PromotionsController {
  constructor(private readonly service: PromotionsService) {}

  @Get()
  @Roles(
    UserRole.ENCARGADO,
    UserRole.CAJERO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.VENDEDOR,
  )
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('activeNow') activeNow?: string,
    @Query('channel') channel?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.service.findAll(
      resolveBusinessId(user, qBid),
      {
        activeNow: activeNow === 'true' || activeNow === '1',
        channel,
        includeInactive:
          includeInactive !== undefined
            ? includeInactive === 'true' || includeInactive === '1'
            : undefined,
      },
      user.role,
    );
  }

  @Get(':id')
  @Roles(
    UserRole.ENCARGADO,
    UserRole.CAJERO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.VENDEDOR,
  )
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findOne(resolveBusinessId(user, qBid), id);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreatePromotionDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.create(resolveBusinessId(user, qBid), dto);
  }

  @Patch(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePromotionDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.update(resolveBusinessId(user, qBid), id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.remove(resolveBusinessId(user, qBid), id);
  }
}
