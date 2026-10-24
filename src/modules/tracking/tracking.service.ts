import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  isRedisEnabled,
  attachSafeRedisErrorHandler,
  getOptimizedRedisOptions,
  logThrottledRedisError,
} from '../../common/utils/redis.util';

@Injectable()
export class TrackingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackingService.name);
  private redis: Redis | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    if (!isRedisEnabled(this.config)) {
      this.redis = null;
      this.logger.log('[TrackingService] Redis deshabilitado. Operando sin caché de Redis.');
      return;
    }

    const redisConf = getOptimizedRedisOptions(this.config);
    this.redis = redisConf.url
      ? new Redis(redisConf.url, { ...redisConf.options, maxRetriesPerRequest: 1 })
      : new Redis({ ...redisConf.options, maxRetriesPerRequest: 1 });

    attachSafeRedisErrorHandler(this.redis, 'TrackingService', this.logger);
  }

  onModuleDestroy() {
    if (this.redis) {
      try {
        this.redis.disconnect();
      } catch {}
    }
  }

  async saveLastPosition(orderId: string, lat: number, lng: number, speed?: number): Promise<void> {
    if (!this.redis) return;
    try {
      const key = `last_position:${orderId}`;
      const value = JSON.stringify({ lat, lng, speed, timestamp: new Date().toISOString() });
      await this.redis.setex(key, 7200, value);
    } catch (err: any) {
      logThrottledRedisError('TrackingService:saveLastPosition', err, this.logger);
    }
  }

  async getLastPosition(orderId: string): Promise<{ lat: number; lng: number; speed?: number; timestamp: string } | null> {
    if (!this.redis) return null;
    try {
      const key = `last_position:${orderId}`;
      const value = await this.redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (err: any) {
      logThrottledRedisError('TrackingService:getLastPosition', err, this.logger);
      return null;
    }
  }

  async saveSnapshotIfNeeded(
    orderId: string,
    userId: string,
    lat: number,
    lng: number,
    speed?: number,
    isMock?: boolean,
  ): Promise<void> {
    const now = Date.now();
    let shouldSave = true;

    if (this.redis) {
      try {
        const snapshotKey = `last_snapshot:${orderId}`;
        const lastSnapshot = await this.redis.get(snapshotKey);

        if (lastSnapshot && now - parseInt(lastSnapshot) < 30000) {
          shouldSave = false;
        } else {
          await this.redis.setex(snapshotKey, 60, now.toString());
        }
      } catch (err: any) {
        logThrottledRedisError('TrackingService:saveSnapshot', err, this.logger);
      }
    }

    if (shouldSave) {
      await this.prisma.locationSnapshot.create({
        data: { orderId, userId, lat, lng, speed, isMock: isMock || false },
      });
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
    if (this.redis) {
      try {
        const cached = await this.redis.get(key);
        if (cached) {
          try {
            return JSON.parse(cached);
          } catch (err) {
            this.logger.warn(`[getGeofenceMeta] Error parseando JSON de caché para orderId=${orderId}`);
          }
        }
      } catch (err: any) {
        logThrottledRedisError('TrackingService:getGeofenceMeta', err, this.logger);
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

    if (this.redis) {
      try {
        await this.redis.setex(key, 7200, JSON.stringify(meta));
      } catch (err: any) {
        // Ignorar fallo de escritura en caché
      }
    }
    return meta;
  }

  async setGeofenceMeta(orderId: string, meta: any): Promise<void> {
    if (!this.redis) return;
    try {
      const key = `geofence_meta:${orderId}`;
      await this.redis.setex(key, 7200, JSON.stringify(meta));
    } catch (err: any) {
      logThrottledRedisError('TrackingService:setGeofenceMeta', err, this.logger);
    }
  }

  async updateGeofenceMetaStatus(orderId: string, status: string): Promise<void> {
    const meta = await this.getGeofenceMeta(orderId);
    if (meta) {
      meta.status = status;
      await this.setGeofenceMeta(orderId, meta);
    }
  }

  async invalidateGeofenceMeta(orderId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(`geofence_meta:${orderId}`);
    } catch (err: any) {
      logThrottledRedisError('TrackingService:invalidateGeofenceMeta', err, this.logger);
    }
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
      let alreadyTriggeredBiz = null;
      if (this.redis) {
        try {
          alreadyTriggeredBiz = await this.redis.get(geofenceBizKey);
        } catch (err: any) {
          logThrottledRedisError('TrackingService:checkGeofenceBiz', err, this.logger);
        }
      }

      if (!alreadyTriggeredBiz) {
        const isNearBiz = this.isNearDestination(
          currentLat,
          currentLng,
          meta.bizLat,
          meta.bizLng,
          100
        );

        if (isNearBiz) {
          if (this.redis) {
            try {
              await this.redis.setex(geofenceBizKey, 3600, '1');
            } catch (err: any) {}
          }

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
    let alreadyTriggered = null;
    if (this.redis) {
      try {
        alreadyTriggered = await this.redis.get(geofenceKey);
      } catch (err: any) {
        logThrottledRedisError('TrackingService:checkGeofenceDest', err, this.logger);
      }
    }
    if (alreadyTriggered) return;

    const isNear = this.isNearDestination(
      currentLat,
      currentLng,
      meta.destinationLat,
      meta.destinationLng,
      meta.geofenceRadiusM,
    );

    if (!isNear) return;

    if (this.redis) {
      try {
        await this.redis.setex(geofenceKey, 3600, '1');
      } catch (err: any) {}
    }

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
    if (!this.redis) return;
    try {
      await this.redis.del(`geofence_triggered:${orderId}`);
    } catch (err: any) {
      logThrottledRedisError('TrackingService:cleanupGeofenceFlag', err, this.logger);
    }
  }

  async cleanupOrderRedisKeys(orderId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(
        `last_position:${orderId}`,
        `last_snapshot:${orderId}`,
        `geofence_triggered:${orderId}`,
        `geofence_biz_triggered:${orderId}`,
        `geofence_meta:${orderId}`,
      );
    } catch (err: any) {
      logThrottledRedisError('TrackingService:cleanupOrderKeys', err, this.logger);
    }
  }

  async updateUserLocation(userId: string, lat: number, lng: number): Promise<void> {
    const now = Date.now();
    let shouldUpdateDb = true;

    if (this.redis) {
      try {
        const lastUpdateKey = `last_user_loc_update:${userId}`;
        const lastUpdate = await this.redis.get(lastUpdateKey);
        if (lastUpdate && now - parseInt(lastUpdate) < 10000) {
          shouldUpdateDb = false;
        } else {
          await this.redis.setex(lastUpdateKey, 10, now.toString());
        }
      } catch (err: any) {
        // Si Redis falla, procedemos a actualizar directamente en Postgres
      }
    }

    if (shouldUpdateDb) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          currentLatitude: lat,
          currentLongitude: lng,
          lastLocationAt: new Date(),
        },
      });
    }
  }
}

