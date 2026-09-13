import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { AdminCreateUserDto } from './dto/admin-create-user.dto';
import { AdminResetPasswordDto } from './dto/admin-reset-password.dto';
import { AdminUpdateStatusDto } from './dto/admin-update-status.dto';
import { AdminListUsersQueryDto } from './dto/admin-list-users-query.dto';
import * as bcrypt from 'bcrypt';

const USER_SELECT_FIELDS = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  businessId: true,
  createdAt: true,
  isAvailable: true,
  profilePhotoUrl: true,
};

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createUser(currentUser: JwtPayload, dto: AdminCreateUserDto) {
    let targetBusinessId: string | null = null;
    let targetRole: UserRole = dto.role;

    if (currentUser.role === UserRole.ENCARGADO) {
      if (dto.role !== UserRole.CAJERO) {
        throw new ForbiddenException('El encargado solo puede crear usuarios con rol CAJERO');
      }
      if (!currentUser.businessId) {
        throw new ForbiddenException('El usuario encargado no tiene un negocio asignado');
      }
      targetBusinessId = currentUser.businessId;
      targetRole = UserRole.CAJERO;
    } else if (currentUser.role === UserRole.SUPERADMIN) {
      targetBusinessId = dto.businessId || null;
      targetRole = dto.role;
    } else {
      throw new ForbiddenException('No tienes permisos para crear usuarios');
    }

    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      throw new ConflictException('Email ya registrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name.trim(),
        email: normalizedEmail,
        phone: dto.phone?.trim() || null,
        passwordHash,
        role: targetRole,
        businessId: targetBusinessId,
      },
      select: USER_SELECT_FIELDS,
    });

    this.logger.log(`[createUser] OK id=${user.id}, email=${user.email}, role=${user.role}, businessId=${user.businessId}, createdBy=${currentUser.sub}`);
    return user;
  }

  async listUsers(currentUser: JwtPayload, query: AdminListUsersQueryDto) {
    const where: any = {};

    if (currentUser.role === UserRole.ENCARGADO) {
      if (!currentUser.businessId) {
        return [];
      }
      where.businessId = currentUser.businessId;
    } else if (currentUser.role === UserRole.SUPERADMIN) {
      if (query.businessId) {
        where.businessId = query.businessId;
      }
    } else {
      throw new ForbiddenException('No tienes permisos para listar usuarios');
    }

    return this.prisma.user.findMany({
      where,
      select: USER_SELECT_FIELDS,
      orderBy: { createdAt: 'desc' },
    });
  }

  async resetPassword(currentUser: JwtPayload, targetUserId: string, dto: AdminResetPasswordDto) {
    if (targetUserId === currentUser.sub) {
      throw new ForbiddenException('No puedes cambiar tu propia contraseña a través de este endpoint');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (currentUser.role === UserRole.ENCARGADO) {
      if (targetUser.role !== UserRole.CAJERO || targetUser.businessId !== currentUser.businessId) {
        throw new ForbiddenException('Solo puedes cambiar la contraseña de cajeros pertenecientes a tu negocio');
      }
    } else if (currentUser.role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException('No tienes permisos para cambiar contraseñas');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: targetUser.id },
        data: { passwordHash },
      }),
      this.prisma.passwordChangeLog.create({
        data: {
          targetUserId: targetUser.id,
          changedByUserId: currentUser.sub,
        },
      }),
    ]);

    this.logger.log(`[resetPassword] OK targetUserId=${targetUser.id}, changedBy=${currentUser.sub}`);
    return {
      message: 'Contraseña actualizada exitosamente',
      userId: targetUser.id,
    };
  }

  async updateStatus(currentUser: JwtPayload, targetUserId: string, dto: AdminUpdateStatusDto) {
    if (targetUserId === currentUser.sub) {
      throw new ForbiddenException('No puedes modificar tu propio estado de actividad');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (currentUser.role === UserRole.ENCARGADO) {
      if (targetUser.role !== UserRole.CAJERO || targetUser.businessId !== currentUser.businessId) {
        throw new ForbiddenException('Solo puedes modificar el estado de cajeros pertenecientes a tu negocio');
      }
    } else if (currentUser.role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException('No tienes permisos para modificar usuarios');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUser.id },
      data: { isActive: dto.isActive },
      select: USER_SELECT_FIELDS,
    });

    this.logger.log(`[updateStatus] OK targetUserId=${targetUser.id}, isActive=${dto.isActive}, changedBy=${currentUser.sub}`);
    return updated;
  }
}
