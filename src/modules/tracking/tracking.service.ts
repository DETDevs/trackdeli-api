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

    await this.redis.setex(key, 7200, value);
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
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  isNearDestination(
    currentLat: number,
    currentLng: number,
    destLat: number,
    destLng: number,
    radiusM: number,
  ): boolean {
    const distanceKm = this.calculateDistance(currentLat, currentLng, destLat, destLng);
    return distanceKm * 1000 <= radiusM;
  }

  async getTrackingDataByToken(token: string) {
    this.logger.debug(`[Tracking] Buscando sesión por token: ${token.substring(0, 20)}...`);

    const session = await this.prisma.trackingSession.findUnique({
      where: { token },
      include: {
        order: {
          include: {
            deliveryUser: {
              select: {
                id: true,
                name: true,
                phone: true,
                vehicleType: true,
                vehiclePlate: true,
                vehicleColor: true,
                profilePhotoUrl: true,
                currentLatitude: true,
                currentLongitude: true,
                lastLocationAt: true,
              },
            },
            business: {
              select: {
                id: true,
                latitude: true,
                longitude: true,
                name: true,
                logoUrl: true,
                whatsappNumber: true,
                whatsappDisplay: true,
              },
            },
            photos: {
              where: { type: 'ARMADO' },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });

    if (!session) {
      this.logger.warn(`[Tracking] Token no encontrado en DB: ${token.substring(0, 20)}...`);
      return null;
    }

    if (!session.isActive) {
      this.logger.warn(`[Tracking] Token desactivado: orderId=${session.orderId}`);
      return null;
    }

    if (session.expiresAt < new Date()) {
      this.logger.warn(`[Tracking] Token expirado: orderId=${session.orderId}, expiresAt=${session.expiresAt.toISOString()}`);
      return null;
    }

    let lastPosition = await this.getLastPosition(session.orderId);

    if (
      !lastPosition &&
      session.order.deliveryUser?.currentLatitude &&
      session.order.deliveryUser?.currentLongitude
    ) {
      lastPosition = {
        lat: session.order.deliveryUser.currentLatitude,
        lng: session.order.deliveryUser.currentLongitude,
        speed: 0,
        timestamp: session.order.deliveryUser.lastLocationAt
          ? session.order.deliveryUser.lastLocationAt.toISOString()
          : new Date().toISOString(),
      };
    }

    this.logger.debug(`[Tracking] Sesión encontrada: orderId=${session.orderId}, status=${session.order.status}`);

    return {
      orderId: session.orderId,
      status: session.order.status,
      customerName: session.order.customerName,
      destinationLat: session.order.destinationLat,
      destinationLng: session.order.destinationLng,
      geofenceRadiusM: session.order.geofenceRadiusM,
      deliveryUser: session.order.deliveryUser,
      photos: session.order.photos,
      lastPosition,
      business: session.order.business,
    };
  }

  async getGeofenceMeta(orderId: string): Promise<{
    status: string;
    deliveryUserId: string | null;
    destinationLat: number | null;
    destinationLng: number | null;
    geofenceRadiusM: number;
    bizLat: number | null;
    bizLng: number | null;
  } | null> {
    const key = `geofence_meta:${orderId}`;
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (err) {
        this.logger.warn(`[getGeofenceMeta] Error parseando JSON de caché para orderId=${orderId}`);
      }
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        destinationLat: true,
        destinationLng: true,
        geofenceRadiusM: true,
        deliveryUserId: true,
        business: {
          select: { latitude: true, longitude: true },
        },
      },
    });

    if (!order) return null;

    const meta = {
      status: order.status,
      deliveryUserId: order.deliveryUserId,
      destinationLat: order.destinationLat ? Number(order.destinationLat) : null,
      destinationLng: order.destinationLng ? Number(order.destinationLng) : null,
      geofenceRadiusM: order.geofenceRadiusM,
      bizLat: order.business?.latitude ? Number(order.business.latitude) : null,
      bizLng: order.business?.longitude ? Number(order.business.longitude) : null,
    };

    await this.redis.setex(key, 7200, JSON.stringify(meta));
    return meta;
  }

  async setGeofenceMeta(orderId: string, meta: any): Promise<void> {
    const key = `geofence_meta:${orderId}`;
    await this.redis.setex(key, 7200, JSON.stringify(meta));
  }

  async updateGeofenceMetaStatus(orderId: string, status: string): Promise<void> {
    const meta = await this.getGeofenceMeta(orderId);
    if (meta) {
      meta.status = status;
      await this.setGeofenceMeta(orderId, meta);
    }
  }

  async invalidateGeofenceMeta(orderId: string): Promise<void> {
    await this.redis.del(`geofence_meta:${orderId}`);
  }

  async checkGeofenceAndTransition(
    orderId: string,
    userId: string,
    currentLat: number,
    currentLng: number,
    gateway: any,
  ): Promise<void> {
    const meta = await this.getGeofenceMeta(orderId);
    if (!meta || meta.deliveryUserId !== userId) return;

    if (meta.status === 'EN_CAMINO_AL_NEGOCIO' && meta.bizLat && meta.bizLng) {
      const geofenceBizKey = `geofence_biz_triggered:${orderId}`;
      const alreadyTriggeredBiz = await this.redis.get(geofenceBizKey);

      if (!alreadyTriggeredBiz) {
        const isNearBiz = this.isNearDestination(
          currentLat,
          currentLng,
          meta.bizLat,
          meta.bizLng,
          100
        );

        if (isNearBiz) {
          await this.redis.setex(geofenceBizKey, 3600, '1');
          await this.prisma.order.update({
            where: { id: orderId },
            data: {
              status: 'EN_EL_NEGOCIO',
              arrivedAtBusinessAt: new Date(),
            },
          });
          meta.status = 'EN_EL_NEGOCIO';
          await this.setGeofenceMeta(orderId, meta);
          gateway.emitOrderStatusChange(orderId, 'EN_EL_NEGOCIO');
          gateway.emitToOrder(orderId, 'geofence_business_triggered', { orderId });
          const distToBusiness = this.calculateDistance(currentLat, currentLng, meta.bizLat, meta.bizLng);
          this.logger.log(`[TrackingGateway] GEOFENCE NEGOCIO TRIGGERED: orderId=${orderId}, distancia=${(distToBusiness * 1000).toFixed(0)}m → EN_EL_NEGOCIO`);
        }
      }
    }

    if (meta.status !== 'EN_CAMINO') return;

    if (!meta.destinationLat || !meta.destinationLng) return;

    const geofenceKey = `geofence_triggered:${orderId}`;
    const alreadyTriggered = await this.redis.get(geofenceKey);
    if (alreadyTriggered) return;

    const isNear = this.isNearDestination(
      currentLat,
      currentLng,
      meta.destinationLat,
      meta.destinationLng,
      meta.geofenceRadiusM,
    );

    if (!isNear) return;

    await this.redis.setex(geofenceKey, 3600, '1');

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CERCA_DEL_DESTINO' },
    });
    meta.status = 'CERCA_DEL_DESTINO';
    await this.setGeofenceMeta(orderId, meta);

    gateway.emitOrderStatusChange(orderId, 'CERCA_DEL_DESTINO');

    gateway.emitToOrder(orderId, 'geofence_triggered', {
      orderId,
      message: 'Has llegado cerca del destino. Por favor verifica la entrega.',
      timestamp: new Date().toISOString(),
    });

    const distanceKm = this.calculateDistance(currentLat, currentLng, meta.destinationLat, meta.destinationLng);
    this.logger.log(`[TrackingGateway] GEOFENCE TRIGGERED: orderId=${orderId}, distancia=${(distanceKm * 1000).toFixed(0)}m, radio=${meta.geofenceRadiusM}m → CERCA_DEL_DESTINO`);
  }

  async cleanupGeofenceFlag(orderId: string): Promise<void> {
    await this.redis.del(`geofence_triggered:${orderId}`);
  }

  async cleanupOrderRedisKeys(orderId: string): Promise<void> {
    await this.redis.del(`last_position:${orderId}`);
    await this.redis.del(`last_snapshot:${orderId}`);
    await this.redis.del(`geofence_triggered:${orderId}`);
    await this.redis.del(`geofence_biz_triggered:${orderId}`);
    await this.redis.del(`geofence_meta:${orderId}`);
  }

  async updateUserLocation(userId: string, lat: number, lng: number): Promise<void> {

    const lastUpdateKey = `last_user_loc_update:${userId}`;
    const lastUpdate = await this.redis.get(lastUpdateKey);
    const now = Date.now();

    if (!lastUpdate || now - parseInt(lastUpdate) >= 10000) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          currentLatitude: lat,
          currentLongitude: lng,
          lastLocationAt: new Date(),
        },
      });
      await this.redis.setex(lastUpdateKey, 10, now.toString());
    }
  }
}

