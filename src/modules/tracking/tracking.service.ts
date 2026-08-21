import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async getByToken(token: string) {
    const session = await this.prisma.trackingSession.findUnique({
      where: { token },
      include: {
        order: {
          include: {
            deliveryUser: true,
            photos: {
              where: { type: 'ARMADO' },
            }
          }
        }
      }
    });

    if (!session || !session.isActive || session.expiresAt < new Date()) {
      throw new NotFoundException('Link no válido o expirado');
    }

    const { order } = session;

    return {
      status: order.status,
      customerName: order.customerName,
      destinationLat: order.destinationLat ? Number(order.destinationLat) : null,
      destinationLng: order.destinationLng ? Number(order.destinationLng) : null,
      deliveryUser: order.deliveryUser ? {
        name: order.deliveryUser.name,
      } : null,
      photos: order.photos,
    };
  }
}
