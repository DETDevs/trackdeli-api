import { Injectable, NotFoundException, ForbiddenException, UnprocessableEntityException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
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

  async validateAndHashPin(businessId: string, pin: string, excludeUserId?: string): Promise<string> {
    const cleanPin = pin ? pin.toString().trim() : '';
    if (!/^\d{4,6}$/.test(cleanPin)) {
      throw new BadRequestException('El PIN debe tener entre 4 y 6 dígitos numéricos');
    }

    // 1. Comparar con otros usuarios activos con PIN del mismo negocio
    const otherUsers = await this.prisma.user.findMany({
      where: {
        businessId,
        isActive: true,
        ...(excludeUserId && { id: { not: excludeUserId } }),
        pinHash: { not: null },
      },
      select: { id: true, pinHash: true },
    });

    for (const other of otherUsers) {
      if (other.pinHash && (await bcrypt.compare(cleanPin, other.pinHash))) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'PIN_IN_USE',
          message: 'El PIN ingresado ya está en uso por otro colaborador',
        });
      }
    }

    // 2. Comparar con meseros activos del mismo negocio con PIN
    const waiters = await this.prisma.waiter.findMany({
      where: {
        businessId,
        active: true,
      },
      select: { id: true, pinHash: true },
    });

    for (const w of waiters) {
      if (w.pinHash && (await bcrypt.compare(cleanPin, w.pinHash))) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'PIN_IN_USE',
          message: 'El PIN ingresado ya está en uso por otro colaborador',
        });
      }
    }

    return bcrypt.hash(cleanPin, 10);
  }

  async setUserPin(businessId: string, userId: string, pin: string, updaterId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, businessId, isActive: true },
    });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado en este negocio');
    }

    const pinHash = await this.validateAndHashPin(businessId, pin, userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { pinHash },
    });

    this.logger.log(`[setUserPin] updaterId=${updaterId} asignó PIN a userId=${userId} en businessId=${businessId}`);
    return { success: true, message: 'PIN actualizado exitosamente' };
  }

  async getUsers(businessId: string) {
    const rawUsers = await this.prisma.user.findMany({
      where: { businessId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        pinHash: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const users = rawUsers.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      isActive: u.isActive,
      hasPin: Boolean(u.pinHash),
      createdAt: u.createdAt,
    }));
    const usage = await this.quotaService.getUsage(businessId);
    return { users, usage };
  }

  async createUser(businessId: string, dto: any, creatorId: string) {
    if (dto.role === UserRole.WAITER) {
      throw new UnprocessableEntityException('Los meseros se gestionan en su propia sección (pos_waiters). No se permite crear rol WAITER aquí.');
    }
    if (dto.role !== UserRole.CAJERO) {
      throw new UnprocessableEntityException('Rol inválido. Solo puede crear CAJERO.');
    }
    
    await this.quotaService.checkQuota(businessId);

    const tempPassword = this.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const pinHash = dto.pin ? await this.validateAndHashPin(businessId, dto.pin) : null;
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
        pinHash,
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
    if (dto.pin !== undefined) {
      updateData.pinHash = dto.pin ? await this.validateAndHashPin(businessId, dto.pin, id) : null;
    }

    if (dto.role) {
      if (user.id === updaterId) {
        throw new ForbiddenException('No puede cambiar su propio rol');
      }
      if (dto.role === UserRole.WAITER) {
        throw new UnprocessableEntityException('Los meseros se gestionan en su propia sección (pos_waiters). No se permite asignar rol WAITER aquí.');
      }
      if (dto.role !== UserRole.CAJERO) {
        throw new UnprocessableEntityException('Solo puede cambiar el rol a CAJERO');
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
