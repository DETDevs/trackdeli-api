import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFiles, UseInterceptors, ForbiddenException } from '@nestjs/common';
import { UploadService } from './upload.service';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { OrderPhotoType, OrderStatus, UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { PrismaService } from '../../prisma/prisma.service';

// The requirements say to map photos to /orders/:id/photos
// We will use @Controller() with absolute paths or split into two controllers.
// Using @Controller('orders') for the photos and a separate or combined one for health.
@Controller()
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('upload/health')
  @Public()
  healthCheck() {
    return { status: 'ok', module: 'upload' };
  }

  @Post('orders/:id/photos')
  @Roles(UserRole.REPARTIDOR, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @UseInterceptors(FilesInterceptor('photos', 5, {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype.startsWith('image/')) {
        return cb(new BadRequestException('Solo se aceptan imágenes'), false);
      }
      cb(null, true);
    },
  }))
  async uploadPhotos(
    @Param('id') orderId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('type') type: OrderPhotoType,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se enviaron imágenes');
    }

    if (!type || (type !== OrderPhotoType.ARMADO && type !== OrderPhotoType.ENTREGA)) {
      throw new BadRequestException('Tipo de foto inválido');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order || order.businessId !== user.businessId) {
      throw new BadRequestException('Pedido no encontrado');
    }

    if (type === OrderPhotoType.ARMADO && order.status !== OrderStatus.TOMADO) {
      throw new BadRequestException('Para subir foto de armado, el pedido debe estar en estado TOMADO');
    }

    if (type === OrderPhotoType.ENTREGA && order.status !== OrderStatus.VERIFICANDO_ENTREGA) {
      throw new BadRequestException('Para subir foto de entrega, el pedido debe estar en estado VERIFICANDO_ENTREGA');
    }

    const folder = type === OrderPhotoType.ARMADO ? 'orders/armado' : 'orders/entrega';
    const uploadedPhotos = [];

    for (const file of files) {
      const photoUrl = await this.uploadService.uploadPhoto(file, folder);
      
      const orderPhoto = await this.prisma.orderPhoto.create({
        data: {
          orderId,
          photoUrl,
          type,
        },
      });
      
      uploadedPhotos.push(orderPhoto);
    }

    if (type === OrderPhotoType.ARMADO && order.status === OrderStatus.TOMADO) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.EN_CAMINO },
      });
    }

    return uploadedPhotos;
  }

  @Get('orders/:id/photos')
  @Roles(UserRole.REPARTIDOR, UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getPhotos(
    @Param('id') orderId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order || order.businessId !== user.businessId) {
      throw new BadRequestException('Pedido no encontrado');
    }

    return this.prisma.orderPhoto.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
