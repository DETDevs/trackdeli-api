import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { OrderStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateQuoteFeeDto } from '../quotes/dto/update-quote-fee.dto';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('status') status?: OrderStatus,
    @Query('latitude') latitude?: number,
    @Query('longitude') longitude?: number,
  ) {
    return this.service.findAllByBusiness(user.businessId, user.sub, user.role, { status, latitude, longitude });
  }

  @Get('calculate-fee')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  calculateFee(
    @Query('destLat') destLat: string,
    @Query('destLng') destLng: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.calculateFee(parseFloat(destLat), parseFloat(destLng), user.businessId);
  }

  @Get(':id')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.service.findOne(id, user.businessId, user.sub, user.role);
  }

  @Post()
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: JwtPayload) {
    return this.service.create(dto, user.sub, user.businessId);
  }

  @Post(':id/take')
  @Roles(UserRole.REPARTIDOR)
  takeOrder(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    // Para REPARTIDOR, el businessId del token puede ser null si es independiente
    return this.service.takeOrder(id, user.sub);
  }

  @Patch(':id/status')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: JwtPayload
  ) {
    return this.service.updateStatus(id, dto, user.sub, user.role, user.businessId);
  }

  @Get(':id/quotes')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  getOrderQuotes(
    @Param('id') orderId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getOrderQuotes(orderId, user.businessId, user.sub, user.role);
  }

  @Post(':id/quotes/:quoteId/accept')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ENCARGADO)
  acceptQuote(
    @Param('id') orderId: string,
    @Param('quoteId') quoteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.acceptQuote(orderId, quoteId, user.businessId!);
  }

  @Get(':id/quotes/:quoteId/messages')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  getQuoteMessages(
    @Param('id') orderId: string,
    @Param('quoteId') quoteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getQuoteMessages(orderId, quoteId, user.sub, user.role, user.businessId);
  }

  @Post(':id/quotes/:quoteId/messages')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR)
  sendQuoteMessage(
    @Param('id') orderId: string,
    @Param('quoteId') quoteId: string,
    @Body() dto: { message: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.sendQuoteMessage(orderId, quoteId, user.sub, user.role, user.businessId, dto);
  }

  @Patch(':id/quotes/:quoteId/update-fee')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.REPARTIDOR)
  updateQuoteFeePatch(
    @Param('id') orderId: string,
    @Param('quoteId') quoteId: string,
    @Body() dto: UpdateQuoteFeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateQuoteFee(orderId, quoteId, user.sub, dto);
  }

  @Post(':id/quotes/:quoteId/update-fee')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.REPARTIDOR)
  updateQuoteFeePost(
    @Param('id') orderId: string,
    @Param('quoteId') quoteId: string,
    @Body() dto: UpdateQuoteFeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateQuoteFee(orderId, quoteId, user.sub, dto);
  }

  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'orders' };
  }
}
