import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class TrackingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackingService.name);
  private redis: Redis;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    this.redis = new Redis({
      host: this.config.get<string>('REDIS_HOST'),
      port: parseInt(this.config.get<string>('REDIS_PORT') || '6379'),
      password: this.config.get<string>('REDIS_PASSWORD'),
      tls: this.config.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
    });
  }

  onModuleDestroy() {
    if (this.redis) {
      this.redis.disconnect();
    }
  }

  async saveLastPosition(orderId: string, lat: number, lng: number, speed?: number): Promise<void> {
    const key = `last_position:${orderId}`;
    const value = JSON.stringify({ lat, lng, speed, timestamp: new Date().toISOString() });
    await this.redis.setex(key, 30, value);
  }

  async getLastPosition(orderId: string): Promise<{ lat: number; lng: number; speed?: number; timestamp: string } | null> {
    const key = `last_position:${orderId}`;
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  async saveSnapshotIfNeeded(
    orderId: string,
    userId: string,
    lat: number,
    lng: number,
    speed?: number,
    isMock?: boolean,
  ): Promise<void> {
    const snapshotKey = `last_snapshot:${orderId}`;
    const lastSnapshot = await this.redis.get(snapshotKey);
    const now = Date.now();

    if (!lastSnapshot || now - parseInt(lastSnapshot) >= 30000) {
      await this.prisma.locationSnapshot.create({
        data: { orderId, userId, lat, lng, speed, isMock: isMock || false },
      });
      await this.redis.setex(snapshotKey, 60, now.toString());
    }
  }

  calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
  }

  isNearDestination(
    currentLat: number,
    currentLng: number,
    destLat: number,
    destLng: number,
    radiusMeters: number,
  ): boolean {
    const distanceKm = this.calculateDistance(currentLat, currentLng, destLat, destLng);
    return distanceKm * 1000 <= radiusMeters;
  }

  async getTrackingDataByToken(token: string) {
    const session = await this.prisma.trackingSession.findUnique({
      where: { token },
      include: {
        order: {
          include: {
            deliveryUser: {
              select: { id: true, name: true }, 
            },
            photos: {
              where: { type: 'ARMADO' },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!session || !session.isActive || session.expiresAt < new Date()) {
      return null;
    }

    const lastPosition = await this.getLastPosition(session.orderId);

    return {
      orderId: session.orderId,
      status: session.order.status,
      customerName: session.order.customerName,
      destinationLat: session.order.destinationLat,
      destinationLng: session.order.destinationLng,
      deliveryUser: session.order.deliveryUser,
      photos: session.order.photos,
      lastPosition,
      geofenceRadiusM: session.order.geofenceRadiusM,
    };
  }

  async checkGeofenceAndTransition(
    orderId: string,
    userId: string,
    currentLat: number,
    currentLng: number,
    gateway: any,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        destinationLat: true,
        destinationLng: true,
        geofenceRadiusM: true,
        deliveryUserId: true,
      },
    });

    if (!order || order.status !== 'EN_CAMINO') return;

    if (order.deliveryUserId !== userId) return;

    if (!order.destinationLat || !order.destinationLng) return;

    const geofenceKey = `geofence_triggered:${orderId}`;
    const alreadyTriggered = await this.redis.get(geofenceKey);
    if (alreadyTriggered) return;

    const isNear = this.isNearDestination(
      currentLat,
      currentLng,
      Number(order.destinationLat),
      Number(order.destinationLng),
      order.geofenceRadiusM,
    );

    if (!isNear) return;

    await this.redis.setex(geofenceKey, 3600, '1');

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CERCA_DEL_DESTINO' },
    });

    gateway.emitOrderStatusChange(orderId, 'CERCA_DEL_DESTINO');

    gateway.emitToOrder(orderId, 'geofence_triggered', {
      orderId,
      message: 'Has llegado cerca del destino. Por favor verifica la entrega.',
      timestamp: new Date().toISOString(),
    });

    const distanceKm = this.calculateDistance(currentLat, currentLng, Number(order.destinationLat), Number(order.destinationLng));
    this.logger.log(`[TrackingGateway] GEOFENCE TRIGGERED: orderId=${orderId}, distancia=${(distanceKm * 1000).toFixed(0)}m, radio=${order.geofenceRadiusM}m → CERCA_DEL_DESTINO`);
  }

  async cleanupGeofenceFlag(orderId: string): Promise<void> {
    await this.redis.del(`geofence_triggered:${orderId}`);
  }

  async cleanupOrderRedisKeys(orderId: string): Promise<void> {
    await this.redis.del(`last_position:${orderId}`);
    await this.redis.del(`last_snapshot:${orderId}`);
    await this.redis.del(`geofence_triggered:${orderId}`);
  }
}
