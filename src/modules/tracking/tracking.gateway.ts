import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { TrackingService } from './tracking.service';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  namespace: '/tracking',
  cors: {
    origin: (origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, true);
    },
    credentials: true,
  },
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TrackingGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly config: ConfigService,
    private readonly trackingService: TrackingService,
  ) { }

  async afterInit(server: Server) {
    const redisOptions = {
      host: this.config.get<string>('REDIS_HOST'),
      port: parseInt(this.config.get<string>('REDIS_PORT') || '6379'),
      password: this.config.get<string>('REDIS_PASSWORD'),
      tls: this.config.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
    };

    const pubClient = new Redis(redisOptions);
    const subClient = pubClient.duplicate();

    const ioServer = (server as any).server || server;
    if (typeof ioServer.adapter === 'function') {
      ioServer.adapter(createAdapter(pubClient, subClient));
      this.logger.log('[TrackingGateway] Gateway inicializado con Redis adapter');
    } else {
      this.logger.error('Cannot configure Redis adapter: adapter() method not found on server');
    }
  }

  handleConnection(client: Socket) {
    this.logger.log(`[TrackingGateway] Cliente conectado: socketId=${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`[TrackingGateway] Cliente desconectado: socketId=${client.id}`);
  }

  @SubscribeMessage('join_order')
  async handleJoinOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string; token?: string }
  ) {
    this.logger.log(`[TrackingGateway] join_order: socketId=${client.id}, orderId=${data.orderId}`);
    client.join(`order:${data.orderId}`);

    // Obtener última posición para que el cliente la reciba al instante al conectarse
    const lastPos = await this.trackingService.getLastPosition(data.orderId);
    client.emit('joined_order', {
      orderId: data.orderId,
      room: `order:${data.orderId}`,
      lastPosition: lastPos,
    });

    if (lastPos) {
      client.emit('location_updated', {
        orderId: data.orderId,
        lat: lastPos.lat,
        lng: lastPos.lng,
        speed: lastPos.speed,
        timestamp: lastPos.timestamp,
        isMock: false,
      });
    }
  }

  @SubscribeMessage('leave_order')
  handleLeaveOrder(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string }
  ) {
    client.leave(`order:${data.orderId}`);
  }

  @SubscribeMessage('update_location')
  async handleLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      orderId: string;
      userId: string;
      lat: number;
      lng: number;
      speed?: number;
      isMock?: boolean;
    }
  ) {
    this.logger.debug(`[TrackingGateway] location_updated: orderId=${data.orderId}, lat=${data.lat}, lng=${data.lng}, isMock=${data.isMock ?? false}`);

    // 1. Guardar última posición en Redis
    await this.trackingService.saveLastPosition(data.orderId, data.lat, data.lng, data.speed);

    // 2. Emitir posición a todos los clientes en el room
    this.server.to(`order:${data.orderId}`).emit('location_updated', {
      orderId: data.orderId,
      lat: data.lat,
      lng: data.lng,
      speed: data.speed,
      isMock: data.isMock || false,
      timestamp: new Date().toISOString(),
    });

    // 3. Guardar snapshot en DB cada 30 segundos
    if (data.userId) {
      await this.trackingService.saveSnapshotIfNeeded(
        data.orderId,
        data.userId,
        data.lat,
        data.lng,
        data.speed,
        data.isMock,
      );

      // 4. Update user current location
      await this.trackingService.updateUserLocation(data.userId, data.lat, data.lng);

      // 4. Verificar geofencing automático
      await this.trackingService.checkGeofenceAndTransition(
        data.orderId,
        data.userId,
        data.lat,
        data.lng,
        this,
      );
    }
  }

  emitToOrder(orderId: string, event: string, data: any) {
    this.server.to(`order:${orderId}`).emit(event, data);
  }

  emitOrderStatusChange(orderId: string, status: string) {
    this.server.to(`order:${orderId}`).emit('order_status_changed', {
      orderId,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  @SubscribeMessage('join_business')
  handleJoinBusiness(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { businessId: string }
  ) {
    client.join(`business:${data.businessId}`);
    client.emit('joined_business', { businessId: data.businessId });
    this.logger.log(`[TrackingGateway] join_business: socketId=${client.id}, businessId=${data.businessId}`);
  }

  @SubscribeMessage('join_rider')
  handleJoinRider(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { riderId: string }
  ) {
    client.join(`rider:${data.riderId}`);
    client.emit('joined_rider', { riderId: data.riderId });
    this.logger.log(`[TrackingGateway] join_rider: socketId=${client.id}, riderId=${data.riderId}`);
  }

  emitToBusiness(businessId: string, event: string, data: any) {
    this.server.to(`business:${businessId}`).emit(event, data);
  }

  notifyBusiness(businessId: string, event: string, data: any) {
    this.server.to(`business:${businessId}`).emit(event, data);
  }

  notifyRider(riderId: string, event: string, data: any) {
    this.server.to(`rider:${riderId}`).emit(event, data);
  }
}

