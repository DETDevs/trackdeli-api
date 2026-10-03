import { Injectable, NotFoundException, ForbiddenException, UnprocessableEntityException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { UserQuotaService } from '../../users/user-quota.service';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class PosUsersService {
  private readonly logger = new Logger(PosUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotaService: UserQuotaService,
  ) {}

  private generateTempPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  async getUsers(businessId: string) {
    const users = await this.prisma.user.findMany({
      where: { businessId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' }
    });
    const usage = await this.quotaService.getUsage(businessId);
    return { users, usage };
  }

  async createUser(businessId: string, dto: any, creatorId: string) {
    if (dto.role !== UserRole.CAJERO && dto.role !== UserRole.WAITER) {
      throw new UnprocessableEntityException('Rol inválido. Solo puede crear CAJERO o WAITER.');
    }
    
    if (dto.role === UserRole.WAITER) {
      const business = await this.prisma.business.findUnique({ where: { id: businessId } });
      if (business?.posVertical !== 'RESTAURANTE') {
        throw new UnprocessableEntityException('El rol WAITER solo está permitido para negocios con vertical RESTAURANTE.');
      }
    }

    await this.quotaService.checkQuota(businessId);

    const tempPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const email = dto.email?.trim().toLowerCase();

    if (email) {
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) throw new UnprocessableEntityException('El email ya está en uso');
    }

    const user = await this.prisma.user.create({
      data: {
        businessId,
        name: dto.name,
        email: email || `user-${Date.now()}@trackdeli.temp`,
        phone: dto.phone,
        role: dto.role,
        passwordHash,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
      }
    });

    this.logger.log(`[createUser] creatorId=${creatorId} creó a userId=${user.id} role=${user.role} en businessId=${businessId}`);
    return { user, tempPassword };
  }

  async updateUser(businessId: string, id: string, dto: any, updaterId: string) {
    const user = await this.prisma.user.findFirst({ where: { id, businessId } });
    if (!user) throw new NotFoundException('Usuario no encontrado en este negocio');

    const updateData: any = {};
    if (dto.name) updateData.name = dto.name;
    if (dto.phone !== undefined) updateData.phone = dto.phone;

    if (dto.role) {
      if (user.id === updaterId) {
        throw new ForbiddenException('No puede cambiar su propio rol');
      }
      if (dto.role !== UserRole.CAJERO && dto.role !== UserRole.WAITER) {
        throw new UnprocessableEntityException('Solo puede cambiar el rol a CAJERO o WAITER');
      }
      if (dto.role === UserRole.WAITER) {
        const business = await this.prisma.business.findUnique({ where: { id: businessId } });
        if (business?.posVertical !== 'RESTAURANTE') {
          throw new UnprocessableEntityException('El rol WAITER solo está permitido para negocios con vertical RESTAURANTE.');
        }
      }
      updateData.role = dto.role;
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, createdAt: true }
    });
    this.logger.log(`[updateUser] updaterId=${updaterId} editó a userId=${id}`);
    return updated;
  }

  async deactivateUser(businessId: string, id: string, updaterId: string) {
    const user = await this.prisma.user.findFirst({ where: { id, businessId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (user.id === updaterId) throw new ForbiddenException('No puede desactivarse a sí mismo');

    if (user.role === UserRole.ENCARGADO) {
      const activeEncargados = await this.prisma.user.count({
        where: { businessId, role: UserRole.ENCARGADO, isActive: true, id: { not: id } }
      });
      if (activeEncargados === 0) {
        throw new UnprocessableEntityException('No puede desactivar al único encargado activo del negocio');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, createdAt: true }
    });
    this.logger.log(`[deactivateUser] updaterId=${updaterId} desactivó a userId=${id}`);
    return updated;
  }

  async activateUser(businessId: string, id: string, updaterId: string) {
    const user = await this.prisma.user.findFirst({ where: { id, businessId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    
    if (!user.isActive) {
      await this.quotaService.checkQuota(businessId);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isActive: true },
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, createdAt: true }
    });
    this.logger.log(`[activateUser] updaterId=${updaterId} reactivó a userId=${id}`);
    return updated;
  }

  async resetPassword(businessId: string, id: string, updaterId: string) {
    const user = await this.prisma.user.findFirst({ where: { id, businessId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    const tempPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash }
    });

    this.logger.log(`[resetPassword] updaterId=${updaterId} reinició la contraseña de userId=${id}`);
    return { tempPassword };
  }
}
