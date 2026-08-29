import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from '../orders/orders.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { CounterQuoteDto } from './dto/counter-quote.dto';
import { UpdateQuoteFeeDto } from './dto/update-quote-fee.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { OrderStatus, QuoteStatus, UserRole } from '@prisma/client';

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
    private readonly notificationsService: NotificationsService,
    private readonly ordersService: OrdersService,
  ) {}

  async createQuote(dto: CreateQuoteDto, riderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: { quotes: true, business: true },
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (order.status !== OrderStatus.PENDIENTE && order.status !== OrderStatus.COTIZANDO) {
      throw new BadRequestException('Este pedido ya no acepta propuestas');
    }

    const existingQuote = order.quotes.find(
      (q) => q.riderId === riderId && q.status !== QuoteStatus.CANCELLED,
    );
    if (existingQuote) {
      throw new ConflictException('Ya tenés una propuesta activa para este pedido');
    }

    const quote = await this.prisma.orderQuote.create({
      data: {
        orderId: dto.orderId,
        riderId,
        proposedFee: dto.proposedFee,
        distanceToBusinessKm: dto.distanceToBusinessKm,
        etaToBusinessMin: dto.etaToBusinessMin,
        status: QuoteStatus.PENDING,
      },
      include: {
        rider: {
          select: {
            id: true,
            name: true,
            phone: true,
            vehicleType: true,
            vehicleColor: true,
            vehiclePlate: true,
            profilePhotoUrl: true,
          },
        },
      },
    });

    if (order.status === OrderStatus.PENDIENTE) {
      await this.prisma.order.update({
        where: { id: dto.orderId },
        data: { status: OrderStatus.COTIZANDO },
      });
      this.trackingGateway.emitOrderStatusChange(dto.orderId, OrderStatus.COTIZANDO);
      this.trackingGateway.server
        .to(`business:${order.businessId}`)
        .emit('orders_updated', { businessId: order.businessId });
    }

    if (dto.note) {
      await this.prisma.orderMessage.create({
        data: {
          orderId: dto.orderId,
          quoteId: quote.id,
          senderId: riderId,
          senderRole: UserRole.REPARTIDOR,
          message: dto.note,
        },
      });
    }

    this.trackingGateway.notifyBusiness(order.businessId, 'new_quote', {
      orderId: dto.orderId,
      quote: {
        id: quote.id,
        riderId,
        riderName: quote.rider.name,
        vehicleType: quote.rider.vehicleType,
        proposedFee: dto.proposedFee,
        distanceToBusinessKm: dto.distanceToBusinessKm,
        etaToBusinessMin: dto.etaToBusinessMin,
        note: dto.note,
      },
    });

    await this.notificationsService.notifyBusiness(order.businessId, {
      title: '💰 Nueva propuesta de precio',
      body: `${quote.rider.name} ofrece C$${dto.proposedFee} para entregar el pedido`,
      data: { type: 'NEW_QUOTE', orderId: dto.orderId },
    });

    this.logger.log(
      `[createQuote] Rider ${riderId} propuso C$${dto.proposedFee} para pedido ${dto.orderId}`,
    );

    return quote;
  }

  async getMyQuotes(riderId: string) {
    return this.prisma.orderQuote.findMany({
      where: {
        riderId,
        status: { in: [QuoteStatus.PENDING, QuoteStatus.NEGOTIATING] },
      },
      include: {
        order: {
          select: {
            id: true,
            status: true,
            customerName: true,
            destinationAddress: true,
            business: {
              select: { name: true, latitude: true, longitude: true },
            },
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getQuotes(userId: string, userRole: UserRole, businessId: string | null) {
    if (userRole === UserRole.REPARTIDOR) {
      return this.prisma.orderQuote.findMany({
        where: {
          riderId: userId,
          status: { notIn: [QuoteStatus.CANCELLED, QuoteStatus.REJECTED] },
        },
        include: {
          order: {
            select: {
              id: true,
              status: true,
              customerName: true,
              destinationAddress: true,
              business: { select: { name: true, latitude: true, longitude: true } },
            },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (userRole === UserRole.ENCARGADO) {
      return this.prisma.orderQuote.findMany({
        where: {
          order: { businessId: businessId! },
          status: { notIn: [QuoteStatus.CANCELLED] },
        },
        include: {
          rider: { select: { id: true, name: true, vehicleType: true, profilePhotoUrl: true } },
          order: { select: { id: true, customerName: true, status: true, destinationAddress: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (userRole === UserRole.SUPERADMIN) {
      return this.prisma.orderQuote.findMany({
        where: {
          status: { notIn: [QuoteStatus.CANCELLED] },
        },
        include: {
          rider: { select: { id: true, name: true, vehicleType: true } },
          order: { select: { id: true, customerName: true, status: true, business: { select: { name: true } } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    throw new ForbiddenException();
  }

  async getQuotesByOrder(orderId: string, businessId: string | null, userId: string, userRole: UserRole) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (userRole === UserRole.ENCARGADO && order.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a las propuestas de este negocio');
    }

    if (userRole === UserRole.REPARTIDOR) {
      const myQuote = await this.prisma.orderQuote.findFirst({
        where: { orderId, riderId: userId, status: { not: QuoteStatus.CANCELLED } },
        include: {
          rider: {
            select: {
              id: true,
              name: true,
              phone: true,
              vehicleType: true,
              vehicleColor: true,
              vehiclePlate: true,
              profilePhotoUrl: true,
            },
          },
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              sender: { select: { id: true, name: true, role: true } },
            },
          },
          order: {
            select: {
              id: true,
              status: true,
              customerName: true,
              destinationAddress: true,
              business: { select: { name: true } },
            },
          },
        },
      });
      if (!myQuote) throw new NotFoundException('No tenés propuesta en este pedido');
      return [myQuote];
    }

    return this.prisma.orderQuote.findMany({
      where: {
        orderId,
        status: { not: QuoteStatus.CANCELLED },
      },
      include: {
        rider: {
          select: {
            id: true,
            name: true,
            phone: true,
            vehicleType: true,
            vehicleColor: true,
            vehiclePlate: true,
            profilePhotoUrl: true,
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: { select: { id: true, name: true, role: true } },
          },
        },
      },
      orderBy: [{ distanceToBusinessKm: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async acceptQuote(quoteId: string, businessId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const quote = await tx.orderQuote.findUnique({
        where: { id: quoteId },
        include: { order: true, rider: true },
      });

      if (!quote) {
        throw new NotFoundException('Propuesta no encontrada');
      }

      if (quote.order.businessId !== businessId) {
        throw new ForbiddenException('Sin acceso a esta propuesta');
      }

      if (
        quote.status !== QuoteStatus.PENDING &&
        quote.status !== QuoteStatus.NEGOTIATING
      ) {
        throw new BadRequestException('Esta propuesta ya no puede aceptarse');
      }

      const finalFee = quote.counterFee ?? quote.proposedFee;

      await tx.orderQuote.update({
        where: { id: quoteId },
        data: { status: QuoteStatus.ACCEPTED, finalFee },
      });

      await tx.orderQuote.updateMany({
        where: {
          orderId: quote.orderId,
          id: { not: quoteId },
          status: { in: [QuoteStatus.PENDING, QuoteStatus.NEGOTIATING] },
        },
        data: { status: QuoteStatus.REJECTED },
      });

      await tx.order.update({
        where: { id: quote.orderId },
        data: {
          status: OrderStatus.ACEPTADO,
          deliveryUserId: quote.riderId,
          deliveryFee: finalFee,
          priceNegotiated: true,
          takenAt: new Date(),
        },
      });

      const trackingToken = await this.ordersService.generateTrackingSession(
        quote.orderId,
        tx,
      );

      const rejectedQuotes = await tx.orderQuote.findMany({
        where: { orderId: quote.orderId, status: QuoteStatus.REJECTED },
        select: { riderId: true },
      });

      return {
        quote,
        finalFee,
        trackingToken,
        rejectedRiderIds: rejectedQuotes.map((q) => q.riderId),
      };
    });

    await this.notificationsService.notifyUser(result.quote.riderId, {
      title: '✅ ¡Tu propuesta fue aceptada!',
      body: `Podés salir a recoger el pedido. Tarifa acordada: C$${result.finalFee}`,
      data: {
        type: 'QUOTE_ACCEPTED',
        orderId: result.quote.orderId,
        trackingToken: result.trackingToken,
      },
    });

    for (const riderId of result.rejectedRiderIds) {
      await this.notificationsService.notifyUser(riderId, {
        title: 'Pedido tomado por otro rider',
        body: 'Tu propuesta no fue seleccionada para este pedido',
        data: { type: 'QUOTE_REJECTED', orderId: result.quote.orderId },
      });
      this.trackingGateway.notifyRider(riderId, 'quote_rejected', {
        orderId: result.quote.orderId,
      });
    }

    this.trackingGateway.notifyBusiness(businessId, 'quote_accepted', {
      orderId: result.quote.orderId,
      riderId: result.quote.riderId,
      finalFee: result.finalFee,
    });

    this.trackingGateway.notifyRider(result.quote.riderId, 'your_quote_accepted', {
      orderId: result.quote.orderId,
      finalFee: result.finalFee,
      trackingToken: result.trackingToken,
    });

    this.trackingGateway.emitOrderStatusChange(
      result.quote.orderId,
      OrderStatus.ACEPTADO,
    );

    this.logger.log(
      `[acceptQuote] Propuesta ${quoteId} aceptada — rider=${result.quote.riderId} fee=C$${result.finalFee}`,
    );

    return {
      success: true,
      finalFee: result.finalFee,
      riderId: result.quote.riderId,
      trackingToken: result.trackingToken,
    };
  }

  async counterQuote(
    quoteId: string,
    dto: CounterQuoteDto,
    userId: string,
    businessId: string,
  ) {
    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: quoteId },
      include: { order: { select: { businessId: true } }, rider: true },
    });

    if (!quote) {
      throw new NotFoundException('Propuesta no encontrada');
    }

    if (quote.order.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a esta propuesta');
    }

    if (
      quote.status !== QuoteStatus.PENDING &&
      quote.status !== QuoteStatus.NEGOTIATING
    ) {
      throw new BadRequestException('Esta propuesta ya no está activa para negociar');
    }

    await this.prisma.orderQuote.update({
      where: { id: quoteId },
      data: {
        counterFee: dto.counterFee,
        status: QuoteStatus.NEGOTIATING,
      },
    });

    const message = await this.prisma.orderMessage.create({
      data: {
        orderId: quote.orderId,
        quoteId: quote.id,
        senderId: userId,
        senderRole: UserRole.ENCARGADO,
        message: dto.message,
      },
      include: {
        sender: { select: { id: true, name: true, role: true } },
      },
    });

    await this.notificationsService.notifyUser(quote.riderId, {
      title: '💬 El negocio respondió tu propuesta',
      body: dto.message,
      data: {
        type: 'QUOTE_COUNTER',
        orderId: quote.orderId,
        quoteId: quote.id,
        counterFee: dto.counterFee.toString(),
      },
    });

    this.trackingGateway.notifyRider(quote.riderId, 'quote_counter', {
      quoteId: quote.id,
      orderId: quote.orderId,
      counterFee: dto.counterFee,
      message: dto.message,
    });

    this.logger.log(
      `[counterQuote] Contrapropuesta para quote ${quoteId}: C$${dto.counterFee}`,
    );

    return { success: true, counterFee: dto.counterFee, message };
  }

  async updateFee(quoteId: string, dto: UpdateQuoteFeeDto, riderId: string) {
    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: quoteId },
      include: { order: { select: { businessId: true } }, rider: true },
    });

    if (!quote) {
      throw new NotFoundException('Propuesta no encontrada');
    }

    if (quote.riderId !== riderId) {
      throw new ForbiddenException('No podés modificar esta propuesta');
    }

    if (
      quote.status !== QuoteStatus.PENDING &&
      quote.status !== QuoteStatus.NEGOTIATING
    ) {
      throw new BadRequestException('No podés modificar esta propuesta');
    }

    await this.prisma.orderQuote.update({
      where: { id: quoteId },
      data: {
        proposedFee: dto.newFee,
        status: QuoteStatus.NEGOTIATING,
      },
    });

    let messageRecord: any = null;
    if (dto.message) {
      messageRecord = await this.prisma.orderMessage.create({
        data: {
          orderId: quote.orderId,
          quoteId: quote.id,
          senderId: riderId,
          senderRole: UserRole.REPARTIDOR,
          message: dto.message,
        },
        include: {
          sender: { select: { id: true, name: true, role: true } },
        },
      });
    }

    this.trackingGateway.notifyBusiness(quote.order.businessId, 'quote_updated', {
      quoteId: quote.id,
      orderId: quote.orderId,
      riderId,
      riderName: quote.rider.name,
      newFee: dto.newFee,
      message: dto.message,
    });

    await this.notificationsService.notifyBusiness(quote.order.businessId, {
      title: '💰 Un rider actualizó su precio',
      body: `${quote.rider.name} propone C$${dto.newFee}${dto.message ? ': ' + dto.message : ''}`,
      data: { type: 'QUOTE_UPDATED', orderId: quote.orderId, quoteId: quote.id },
    });

    this.logger.log(
      `[updateFee] Rider ${riderId} actualizó tarifa de quote ${quoteId} a C$${dto.newFee}`,
    );

    return { success: true, newFee: dto.newFee, message: messageRecord };
  }

  async cancelQuote(quoteId: string, riderId: string) {
    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: quoteId },
      include: { order: { select: { businessId: true } } },
    });

    if (!quote || quote.riderId !== riderId) {
      throw new NotFoundException('Propuesta no encontrada');
    }

    if (
      quote.status !== QuoteStatus.PENDING &&
      quote.status !== QuoteStatus.NEGOTIATING
    ) {
      throw new BadRequestException('No podés cancelar esta propuesta');
    }

    await this.prisma.orderQuote.update({
      where: { id: quoteId },
      data: { status: QuoteStatus.CANCELLED },
    });

    const activeQuotes = await this.prisma.orderQuote.count({
      where: {
        orderId: quote.orderId,
        status: { in: [QuoteStatus.PENDING, QuoteStatus.NEGOTIATING] },
      },
    });

    if (activeQuotes === 0) {
      await this.prisma.order.update({
        where: { id: quote.orderId },
        data: { status: OrderStatus.PENDIENTE },
      });
      this.trackingGateway.emitOrderStatusChange(
        quote.orderId,
        OrderStatus.PENDIENTE,
      );
      this.trackingGateway.server
        .to(`business:${quote.order.businessId}`)
        .emit('orders_updated', { businessId: quote.order.businessId });
    }

    this.trackingGateway.notifyBusiness(quote.order.businessId, 'quote_cancelled', {
      quoteId: quote.id,
      orderId: quote.orderId,
      riderId,
    });

    this.logger.log(`[cancelQuote] Rider ${riderId} canceló quote ${quoteId}`);

    return { success: true };
  }

  async sendMessage(
    dto: SendMessageDto,
    userId: string,
    userRole: UserRole,
    businessId: string | null,
  ) {
    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: dto.quoteId },
      include: { order: true, rider: true },
    });

    if (!quote) {
      throw new NotFoundException('Propuesta no encontrada');
    }

    if (userRole === UserRole.REPARTIDOR && quote.riderId !== userId) {
      throw new ForbiddenException('Sin permiso para enviar mensajes en esta propuesta');
    }

    if (userRole === UserRole.ENCARGADO && quote.order.businessId !== businessId) {
      throw new ForbiddenException('Sin permiso para enviar mensajes en esta propuesta');
    }

    const message = await this.prisma.orderMessage.create({
      data: {
        orderId: quote.orderId,
        quoteId: quote.id,
        senderId: userId,
        senderRole: userRole,
        message: dto.message,
      },
      include: {
        sender: { select: { id: true, name: true, role: true } },
      },
    });

    if (userRole === UserRole.ENCARGADO) {
      this.trackingGateway.notifyRider(quote.riderId, 'new_message', {
        quoteId: quote.id,
        orderId: quote.orderId,
        message,
      });

      await this.notificationsService.notifyUser(quote.riderId, {
        title: '💬 Mensaje del negocio',
        body: dto.message,
        data: {
          type: 'NEW_MESSAGE',
          orderId: quote.orderId,
          quoteId: quote.id,
        },
      });
    } else {
      this.trackingGateway.notifyBusiness(quote.order.businessId, 'new_message', {
        quoteId: quote.id,
        orderId: quote.orderId,
        message,
      });

      await this.notificationsService.notifyBusiness(quote.order.businessId, {
        title: `💬 Mensaje de ${quote.rider.name}`,
        body: dto.message,
        data: {
          type: 'NEW_MESSAGE',
          orderId: quote.orderId,
          quoteId: quote.id,
        },
      });
    }

    return message;
  }

  async getMessages(
    quoteId: string,
    userId: string,
    userRole: UserRole,
    businessId: string | null,
  ) {
    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: quoteId },
      include: { order: true },
    });

    if (!quote) {
      throw new NotFoundException('Propuesta no encontrada');
    }

    if (userRole === UserRole.REPARTIDOR && quote.riderId !== userId) {
      throw new ForbiddenException('Sin acceso a los mensajes de esta propuesta');
    }

    if (userRole === UserRole.ENCARGADO && quote.order.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a los mensajes de esta propuesta');
    }

    await this.prisma.orderMessage.updateMany({
      where: {
        quoteId,
        senderId: { not: userId },
        isRead: false,
      },
      data: { isRead: true },
    });

    return this.prisma.orderMessage.findMany({
      where: { quoteId },
      include: {
        sender: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}