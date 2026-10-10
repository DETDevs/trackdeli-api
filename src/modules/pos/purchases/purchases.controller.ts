import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { NoWebPlatformGuard } from '../../../common/guards/no-web-platform.guard';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { VoidPurchaseDto } from './dto/void-purchase.dto';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
@Controller('pos/purchases')
export class PurchasesController {
  constructor(private readonly service: PurchasesService) {}

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.service.findAll(resolveBusinessId(user, qBid), {
      from,
      to,
      supplierId,
      status,
      page,
      limit,
    });
  }

  @Post()
  @UseGuards(NoWebPlatformGuard)
  @UseInterceptors(IdempotencyInterceptor)
  create(
    @Body() dto: CreatePurchaseDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.create(dto, resolveBusinessId(user, qBid), user.sub);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.findOne(id, resolveBusinessId(user, qBid));
  }

  @Post(':id/void')
  @UseGuards(NoWebPlatformGuard)
  @UseInterceptors(IdempotencyInterceptor)
  void(
    @Param('id') id: string,
    @Body() dto: VoidPurchaseDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    return this.service.voidPurchase(id, resolveBusinessId(user, qBid), user.sub, dto);
  }
}
