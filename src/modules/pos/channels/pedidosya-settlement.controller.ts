import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { PedidosYaSettlementService } from './pedidosya-settlement.service';
import {
  CreatePedidosYaSettlementDto,
  PedidosYaSettlementQueryDto,
} from './dto/pedidosya-settlement.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard, RolesGuard)
@Controller('pos/pedidosya')
export class PedidosYaSettlementController {
  constructor(private readonly service: PedidosYaSettlementService) {}

  @Get('settlement')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getSettlement(
    @CurrentUser() user: JwtPayload,
    @Query() query: PedidosYaSettlementQueryDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getSettlementSummary(businessId, query);
  }

  @Post('settlements')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async createSettlement(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePedidosYaSettlementDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.createSettlement(businessId, dto, user.sub);
  }

  @Get('settlements')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getSettlementsHistory(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.getSettlementHistory(businessId);
  }
}
