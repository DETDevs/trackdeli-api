import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInviteCodeDto } from './dto/create-invite-code.dto';

@Injectable()
export class InviteCodesService {
  private readonly logger = new Logger(InviteCodesService.name);

  constructor(private readonly prisma: PrismaService) {}

  private generateOTP(): string {
    // Genera número entre 100000 y 999999
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async createInviteCode(dto: CreateInviteCodeDto, businessId: string) {
    let code: string;
    let attempts = 0;

    // Generar hasta encontrar uno único
    do {
      code = this.generateOTP();
      const existing = await this.prisma.inviteCode.findUnique({
        where: { code },
      });
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    const inviteCode = await this.prisma.inviteCode.create({
      data: {
        businessId,
        code,
        description: dto.description,
        maxUses: dto.maxUses ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true },
        },
      },
    });

    this.logger.log(`[createInviteCode] OTP creado: ${code} para negocio: ${businessId}`);
    return inviteCode;
  }

  async getInviteCodes(businessId: string) {
    return this.prisma.inviteCode.findMany({
      where: { businessId },
      include: {
        _count: {
          select: { usages: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async toggle(id: string, businessId?: string, isSuperAdmin = false) {
    const inviteCode = await this.prisma.inviteCode.findUnique({
      where: { id },
    });

    if (!inviteCode) {
      throw new NotFoundException('Código de invitación no encontrado');
    }

    if (!isSuperAdmin && businessId && inviteCode.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a este código');
    }

    const updated = await this.prisma.inviteCode.update({
      where: { id },
      data: { isActive: !inviteCode.isActive },
    });

    this.logger.log(
      `[toggle] Código ${inviteCode.code} nuevo estado isActive: ${updated.isActive}`,
    );
    return updated;
  }

  async activate(id: string, businessId?: string, isSuperAdmin = false) {
    const inviteCode = await this.prisma.inviteCode.findUnique({
      where: { id },
    });

    if (!inviteCode) {
      throw new NotFoundException('Código de invitación no encontrado');
    }

    if (!isSuperAdmin && businessId && inviteCode.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a este código');
    }

    const updated = await this.prisma.inviteCode.update({
      where: { id },
      data: { isActive: true },
    });

    this.logger.log(`[activate] Código activado: ${inviteCode.code}`);
    return updated;
  }

  async deactivate(id: string, businessId?: string, isSuperAdmin = false) {
    const inviteCode = await this.prisma.inviteCode.findUnique({
      where: { id },
    });

    if (!inviteCode) {
      throw new NotFoundException('Código de invitación no encontrado');
    }

    if (!isSuperAdmin && businessId && inviteCode.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a este código');
    }

    const updated = await this.prisma.inviteCode.update({
      where: { id },
      data: { isActive: false },
    });

    this.logger.log(`[deactivate] Código desactivado: ${inviteCode.code}`);
    return updated;
  }

  async getRiders(id: string, businessId?: string, isSuperAdmin = false) {
    const inviteCode = await this.prisma.inviteCode.findUnique({
      where: { id },
    });

    if (!inviteCode) {
      throw new NotFoundException('Código de invitación no encontrado');
    }

    if (!isSuperAdmin && businessId && inviteCode.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a este código');
    }

    const usages = await this.prisma.inviteCodeUsage.findMany({
      where: { inviteCodeId: id },
      include: {
        rider: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            vehicleType: true,
            vehiclePlate: true,
            vehicleColor: true,
            profilePhotoUrl: true,
            isActive: true,
            isAvailable: true,
            createdAt: true,
          },
        },
      },
      orderBy: { usedAt: 'desc' },
    });

    return usages.map((u) => ({
      ...u.rider,
      usedAt: u.usedAt,
    }));
  }

  async validateCode(code: string) {
    const formattedCode = code.trim();
    const inviteCode = await this.prisma.inviteCode.findUnique({
      where: { code: formattedCode },
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true },
        },
      },
    });

    if (!inviteCode) throw new NotFoundException('Código inválido');
    if (!inviteCode.isActive) throw new BadRequestException('Código inactivo');
    if (inviteCode.expiresAt && new Date() > inviteCode.expiresAt) {
      throw new BadRequestException('Código expirado');
    }
    if (inviteCode.maxUses && inviteCode.usedCount >= inviteCode.maxUses) {
      throw new BadRequestException('Código agotado');
    }

    return {
      valid: true,
      code: inviteCode.code,
      business: {
        id: inviteCode.business.id,
        name: inviteCode.business.name,
        logoUrl: inviteCode.business.logoUrl,
      },
      description: inviteCode.description,
    };
  }
}
