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
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { resolveBusinessId } from '../pos.utils';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { DuplicateQuoteDto } from './dto/duplicate-quote.dto';
import { ListQuotesQueryDto } from './dto/list-quotes-query.dto';
import { UpdateQuoteStatusDto } from './dto/update-quote-status.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { PosQuotesService } from './pos-quotes.service';

@SkipMembershipCheck()
@Controller('pos/quotes')
@UseGuards(JwtAuthGuard, RolesGuard, PosGuard)
export class PosQuotesController {
  constructor(private readonly service: PosQuotesService) {}

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
  create(
    @Body() dto: CreateQuoteDto,
    @CurrentUser() user: JwtPayload,
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
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListQuotesQueryDto,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.findAll(businessId, user, query);
  }

  @Get(':id/prepare-conversion')
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO)
  prepareConversion(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.prepareConversion(businessId, id, user);
  }

  @Get(':id')
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.findOne(businessId, id, user);
  }

  @Patch(':id')
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.update(businessId, id, user, dto);
  }

  @Patch(':id/status')
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteStatusDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.updateStatus(businessId, id, user, dto);
  }

  @Post(':id/duplicate')
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(UserRole.SUPERADMIN, UserRole.ENCARGADO, UserRole.CAJERO, UserRole.VENDEDOR)
  duplicate(
    @Param('id') id: string,
    @Body() dto: DuplicateQuoteDto,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
    @Headers('x-client-request-id') xClientRequestId?: string,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    const resolvedClientId =
      dto?.clientRequestId || xClientRequestId || idempotencyKeyHeader;
    return this.service.duplicate(businessId, id, user, {
      ...dto,
      clientRequestId: resolvedClientId,
    });
  }
}

