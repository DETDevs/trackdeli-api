import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { resolveBusinessId } from '../pos.utils';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { PresaleTicketsService } from './presale-tickets.service';
import { CreatePresaleTicketDto } from './dto/create-presale-ticket.dto';
import { UpdatePresaleItemsDto } from './dto/update-presale-items.dto';
import { ChargePresaleTicketDto } from './dto/charge-presale-ticket.dto';
import { CancelPresaleTicketDto } from './dto/cancel-presale-ticket.dto';

@Controller('pos/presale-tickets')
@UseGuards(JwtAuthGuard, RolesGuard, PosGuard)
export class PresaleTicketsController {
  constructor(private readonly service: PresaleTicketsService) {}

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(UserRole.VENDEDOR, UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(
    @Body() dto: CreatePresaleTicketDto,
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
    @Headers('x-client-request-id') xClientRequestId?: string,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    const resolvedClientId =
      dto.clientRequestId || xClientRequestId || idempotencyKeyHeader;
    if (resolvedClientId) {
      dto.clientRequestId = resolvedClientId;
    }
    return this.service.create(businessId, user, dto);
  }

  @Get()
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findAll(
    @CurrentUser() user: any,
    @Query('status') qStatus?: string,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.findPending(businessId, qStatus);
  }

  @Get('mine')
  @Roles(UserRole.VENDEDOR, UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findMine(
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.findMine(businessId, user.sub);
  }

  @Get('by-code/:scanCode')
  @Roles(UserRole.VENDEDOR, UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findByCode(
    @Param('scanCode') scanCode: string,
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.findByCode(businessId, scanCode, user);
  }

  @Get(':id')
  @Roles(UserRole.VENDEDOR, UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.findById(businessId, id, user);
  }

  @Post(':id/claim')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  claim(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.claim(businessId, id, user);
  }

  @Patch(':id/items')
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  updateItems(
    @Param('id') id: string,
    @Body() dto: UpdatePresaleItemsDto,
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.updateItems(businessId, id, user, dto);
  }

  @Post(':id/charge')
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  charge(
    @Param('id') id: string,
    @Body() dto: ChargePresaleTicketDto,
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
    @Headers('x-channel') channel?: string,
    @Headers('x-device-id') deviceId?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.charge(
      businessId,
      id,
      user,
      { channel, deviceId },
      dto,
    );
  }

  @Post(':id/cancel')
  @Roles(UserRole.VENDEDOR, UserRole.CAJERO, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelPresaleTicketDto,
    @CurrentUser() user: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.cancel(businessId, id, user, dto.reason);
  }
}
