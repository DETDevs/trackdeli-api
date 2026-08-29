import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { CounterQuoteDto } from './dto/counter-quote.dto';
import { UpdateQuoteFeeDto } from './dto/update-quote-fee.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';

@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotesService: QuotesService) {}

  @Post()
  @Roles(UserRole.REPARTIDOR)
  createQuote(
    @Body() dto: CreateQuoteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.createQuote(dto, user.sub);
  }

  @Get('my-quotes')
  @Roles(UserRole.REPARTIDOR)
  getMyQuotes(@CurrentUser() user: JwtPayload) {
    return this.quotesService.getMyQuotes(user.sub);
  }

  @Get()
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  getQuotes(@CurrentUser() user: JwtPayload) {
    return this.quotesService.getQuotes(user.sub, user.role, user.businessId);
  }

  @Get('order/:orderId')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  getQuotesByOrder(
    @Param('orderId') orderId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.getQuotesByOrder(orderId, user.businessId, user.sub, user.role);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ENCARGADO)
  acceptQuote(
    @Param('id') quoteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.acceptQuote(quoteId, user.businessId!);
  }

  @Post(':id/counter')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ENCARGADO)
  counterQuote(
    @Param('id') quoteId: string,
    @Body() dto: CounterQuoteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.counterQuote(quoteId, dto, user.sub, user.businessId!);
  }

  @Post(':id/update-fee')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.REPARTIDOR)
  updateFee(
    @Param('id') quoteId: string,
    @Body() dto: UpdateQuoteFeeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.updateFee(quoteId, dto, user.sub);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.REPARTIDOR)
  cancelQuote(
    @Param('id') quoteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.cancelQuote(quoteId, user.sub);
  }

  @Post('messages')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR)
  sendMessage(
    @Body() dto: SendMessageDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.sendMessage(dto, user.sub, user.role, user.businessId);
  }

  @Get(':id/messages')
  @Roles(UserRole.ENCARGADO, UserRole.REPARTIDOR, UserRole.SUPERADMIN)
  getMessages(
    @Param('id') quoteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.quotesService.getMessages(quoteId, user.sub, user.role, user.businessId);
  }
}