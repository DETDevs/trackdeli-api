import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ExchangeRateService } from './exchange-rate.service';
import { UpdateExchangeRateDto } from './dto/update-exchange-rate.dto';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/exchange-rate')
export class ExchangeRateController {
  constructor(private readonly service: ExchangeRateService) {}

  @Get()
  @Roles(
    UserRole.ENCARGADO,
    UserRole.CAJERO,
    UserRole.SUPERADMIN,
    UserRole.WAITER,
    UserRole.REPARTIDOR,
  )
  getCurrentRate(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getCurrentRate(resolveBusinessId(user, qBid));
  }

  @Put()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateRate(
    @Body() dto: UpdateExchangeRateDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.updateRate(
      resolveBusinessId(user, qBid),
      dto,
      user.sub,
      user.role,
    );
  }

  @Get('history')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  getHistory(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.getHistory(resolveBusinessId(user, qBid));
  }
}
