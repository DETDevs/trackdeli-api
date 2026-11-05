import { Injectable, UnauthorizedException, Logger, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { RegisterRiderDto } from './dto/register-rider.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { User, AuthProvider, BusinessProductType, UserRole } from '@prisma/client';
import { FirebaseService } from '../notifications/firebase.service';
import { PosDevicesService } from '../pos/devices/pos-devices.service';
import { getSalonLabels, resolveSalonProfile } from '../pos/salon/salon-profile.util';
import { computeBusinessMembershipBilling, computeBusinessCoverage, resolveBusinessCoverage } from '../superadmin/utils/membership-billing.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private firebaseService: FirebaseService,
    private posDevicesService: PosDevicesService,
  ) {}

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      this.logger.warn(`[validateUser] WARN usuario no encontrado: ${email}`);
      return null;
    }

    if (user.authProvider !== AuthProvider.EMAIL && !user.passwordHash) {
      this.logger.warn(`[validateUser] WARN intento de login con contraseña en cuenta social: ${email}`);
      throw new UnauthorizedException('Esta cuenta fue creada con redes sociales. Por favor, inicia sesión con Google o Apple.');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash || '');
    if (!isPasswordValid) {
      this.logger.warn(`[validateUser] WARN password incorrecta: ${email}`);
      return null;
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Usuario inactivo');
    }

    return user;
  }

  async canAccessBusiness(
    user: { id: string; role: UserRole; businessId?: string | null; isActive?: boolean },
    targetBusinessId: string,
  ): Promise<boolean> {
    if (!targetBusinessId) return false;
    if (user.isActive === false) return false;
    if (user.role === UserRole.SUPERADMIN) return true;
    if (user.businessId === targetBusinessId) return true;

    // Solo ENCARGADO puede acceder a múltiples sucursales
    if (user.role !== UserRole.ENCARGADO || !user.businessId) return false;

    // Verificar si existe registro de acceso
    const access = await this.prisma.userBusinessAccess.findUnique({
      where: {
        userId_businessId: {
          userId: user.id,
          businessId: targetBusinessId,
        },
      },
    });
    if (!access) return false;

    // Verificar que ambas sucursales pertenezcan a la misma organización no nula
    const [primaryBiz, targetBiz] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: user.businessId },
        select: { organizationId: true, isActive: true },
      }),
      this.prisma.business.findUnique({
        where: { id: targetBusinessId },
        select: { organizationId: true, isActive: true },
      }),
    ]);

    if (!primaryBiz || !targetBiz) return false;
    if (!primaryBiz.organizationId || !targetBiz.organizationId) return false;
    if (primaryBiz.organizationId !== targetBiz.organizationId) return false;

    return true;
  }

  async getUserBranches(user: { id: string; role: UserRole; businessId?: string | null }): Promise<Array<{ id: string; name: string; slug: string | null; isPrimary: boolean }>> {
    if (!user.businessId) {
      return [];
    }

    const primaryBiz = await this.prisma.business.findUnique({
      where: { id: user.businessId },
      select: { id: true, name: true, slug: true, organizationId: true },
    });

    if (!primaryBiz) {
      return [];
    }

    const branches: Array<{ id: string; name: string; slug: string | null; isPrimary: boolean }> = [
      {
        id: primaryBiz.id,
        name: primaryBiz.name,
        slug: primaryBiz.slug,
        isPrimary: true,
      },
    ];

    if (user.role === UserRole.ENCARGADO && primaryBiz.organizationId) {
      const accesses = await this.prisma.userBusinessAccess.findMany({
        where: {
          userId: user.id,
          business: {
            organizationId: primaryBiz.organizationId,
          },
        },
        include: {
          business: {
            select: { id: true, name: true, slug: true },
          },
        },
      });

      for (const acc of accesses) {
        if (acc.business && acc.business.id !== primaryBiz.id) {
          branches.push({
            id: acc.business.id,
            name: acc.business.name,
            slug: acc.business.slug,
            isPrimary: false,
          });
        }
      }
    }

    return branches;
  }

  async getUserBranchesByUserId(userId: string): Promise<Array<{ id: string; name: string; slug: string | null; isPrimary: boolean }>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, businessId: true },
    });
    if (!user) return [];
    return this.getUserBranches(user);
  }

  private async buildBusinessData(businessId: string) {
    const b = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: {
        memberships: {
          include: { paymentProducts: true },
          orderBy: { endDate: 'desc' },
        },
      },
    });
    if (!b) return null;
    const salonProfile = resolveSalonProfile(b.salonProfile);
    const salonLabels = getSalonLabels(salonProfile);
    const billing = computeBusinessMembershipBilling(b, b.memberships);
    const coverage = await resolveBusinessCoverage(this.prisma, b.id);
    if (coverage.source === 'MAINTENANCE_FREE') {
      billing.membership_status = coverage.status;
      billing.due_date = coverage.coveredUntilStr;
      billing.grace_ends_at = coverage.graceEndsAtStr;
      billing.days_until_due = coverage.daysUntilDue;
      billing.due_date_date = coverage.coveredUntil;
      billing.is_active = coverage.isCovered;
      billing.is_in_grace = coverage.isInGrace;
    }
    return {
      businessData: {
        id: b.id,
        name: b.name,
        salonProfile,
        salonLabels,
        posVertical: b.posVertical,
        tracksBatches: b.tracksBatches ?? false,
        useListPrice: b.useListPrice ?? false,
        defaultMarkupPct: b.defaultMarkupPct != null ? Number(b.defaultMarkupPct) : null,
        autoUpdatePriceOnPurchase: b.autoUpdatePriceOnPurchase ?? false,
        twoStepSaleEnabled: b.twoStepSaleEnabled ?? false,
        twoStepTicketTtlHours: b.twoStepTicketTtlHours ?? 4,
        taxId: b.taxId ?? null,
        billing_anchor_day: billing.billing_anchor_day,
        current_period_start: billing.current_period_start,
        due_date: billing.due_date,
        grace_ends_at: billing.grace_ends_at,
        membership_status: billing.membership_status,
        days_until_due: billing.days_until_due,
        membership: {
          status: billing.membership_status,
          billing_anchor_day: billing.billing_anchor_day,
          current_period_start: billing.current_period_start,
          due_date: billing.due_date,
          grace_ends_at: billing.grace_ends_at,
          days_until_due: billing.days_until_due,
          daysLeft: billing.days_until_due,
          endDate: billing.due_date_date,
        },
      },
      salonProfile,
      salonLabels,
    };
  }

  async login(dto: LoginDto, req?: any): Promise<TokenResponseDto> {
    const user = await this.validateUser(dto.email, dto.password);

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    let activeBusinessId: string | null = user.businessId;

    if (dto.businessId) {
      const allowed = await this.canAccessBusiness(user, dto.businessId);
      if (!allowed) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'BRANCH_ACCESS_DENIED',
          message: 'No tenés acceso a esta sucursal.',
        });
      }
      activeBusinessId = dto.businessId;
    }

    let posSub: any = null;
    let trialData: { endsAt: string | null; serverNow: string; remainingSeconds: number | null } | null = null;
    let maxExpiresAt: Date | null = null;

    if (activeBusinessId && user.role !== UserRole.SUPERADMIN) {
      posSub = await this.prisma.businessProductSubscription.findUnique({
        where: {
          businessId_productType: {
            businessId: activeBusinessId,
            productType: BusinessProductType.POS,
          },
        },
      });

      if (posSub && posSub.trialHours !== null && posSub.trialHours >= 1) {
        const now = new Date();

        if (posSub.trialEndsAt && now >= posSub.trialEndsAt) {
          const coverage = await resolveBusinessCoverage(this.prisma, activeBusinessId, now);
          if (!coverage.isCovered) {
            this.logger.warn(`[login] Rechazado por prueba vencida: businessId=${activeBusinessId}, email=${dto.email}`);
            throw new ForbiddenException({
              statusCode: 403,
              error: 'Forbidden',
              code: 'TRIAL_EXPIRED',
              message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
            });
          }
        }

        const headers = req?.headers || {};
        const platformRaw = headers['x-client-platform'] || headers['X-Client-Platform'];
        const isDesktopWin = String(platformRaw || '').trim().toLowerCase() === 'desktop-win';

        if (isDesktopWin && !posSub.trialStartedAt) {
          const trialStartedAt = now;
          const trialEndsAt = new Date(now.getTime() + posSub.trialHours * 60 * 60 * 1000);
          posSub = await this.prisma.businessProductSubscription.update({
            where: { id: posSub.id },
            data: {
              trialStartedAt,
              trialEndsAt,
            },
          });
          this.logger.log(
            `[login] Reloj de prueba iniciado para businessId=${activeBusinessId}: ${posSub.trialHours}h hasta ${trialEndsAt.toISOString()}`,
          );
        }

        if (posSub.trialEndsAt) {
          maxExpiresAt = posSub.trialEndsAt;
        }

        const serverNow = new Date();
        const remainingSeconds = posSub.trialEndsAt
          ? Math.max(0, Math.floor((posSub.trialEndsAt.getTime() - serverNow.getTime()) / 1000))
          : posSub.trialHours * 3600;

        trialData = {
          endsAt: posSub.trialEndsAt ? posSub.trialEndsAt.toISOString() : null,
          serverNow: serverNow.toISOString(),
          remainingSeconds,
        };
      }
    }

    // 132a — Control de dispositivos POS
    await this.posDevicesService.validateAndRegisterOnLogin({ ...user, businessId: activeBusinessId }, req);

    this.logger.log(`[login] OK email=${dto.email}, rol=${user.role}, businessId=${activeBusinessId}`);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      businessId: activeBusinessId || undefined,
      phone: user.phone,
      vehicleType: user.vehicleType,
      vehiclePlate: user.vehiclePlate,
      vehicleColor: user.vehicleColor,
      vehiclePhotoUrl: user.vehiclePhotoUrl,
      profilePhotoUrl: user.profilePhotoUrl,
      isAvailable: user.isAvailable,
      profileComplete: user.profileComplete,
    };

    const tokens = this.generateTokens(payload, maxExpiresAt);

    let businessData: any = null;
    let salonProfile = 'RESTAURANTE';
    let salonLabels = getSalonLabels('RESTAURANTE');
    if (activeBusinessId) {
      const bRes = await this.buildBusinessData(activeBusinessId);
      if (bRes) {
        businessData = bRes.businessData;
        salonProfile = bRes.salonProfile;
        salonLabels = bRes.salonLabels;
      }
    }

    const branches = await this.getUserBranches(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        businessId: activeBusinessId || user.businessId,
        phone: user.phone,
        vehicleType: user.vehicleType,
        vehiclePlate: user.vehiclePlate,
        vehicleColor: user.vehicleColor,
        vehiclePhotoUrl: user.vehiclePhotoUrl,
        profilePhotoUrl: user.profilePhotoUrl,
        isAvailable: user.isAvailable,
        profileComplete: user.profileComplete,
        business: businessData,
        salonProfile,
        salonLabels,
      },
      branches,
      trial: trialData,
    };
  }

  async switchBranch(userId: string, targetBusinessId: string, req?: any): Promise<TokenResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Usuario no válido o inactivo');
    }

    const allowed = await this.canAccessBusiness(user, targetBusinessId);
    if (!allowed) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'BRANCH_ACCESS_DENIED',
        message: 'No tenés acceso a esta sucursal.',
      });
    }

    let posSub: any = null;
    let trialData: { endsAt: string | null; serverNow: string; remainingSeconds: number | null } | null = null;
    let maxExpiresAt: Date | null = null;

    if (user.role !== UserRole.SUPERADMIN) {
      posSub = await this.prisma.businessProductSubscription.findUnique({
        where: {
          businessId_productType: {
            businessId: targetBusinessId,
            productType: BusinessProductType.POS,
          },
        },
      });

      if (posSub && posSub.trialHours !== null && posSub.trialHours >= 1) {
        const now = new Date();
        if (posSub.trialEndsAt && now >= posSub.trialEndsAt) {
          const coverage = await resolveBusinessCoverage(this.prisma, targetBusinessId, now);
          if (!coverage.isCovered) {
            throw new ForbiddenException({
              statusCode: 403,
              error: 'Forbidden',
              code: 'TRIAL_EXPIRED',
              message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
            });
          }
        }
        if (posSub.trialEndsAt) {
          maxExpiresAt = posSub.trialEndsAt;
        }
        const serverNow = new Date();
        const remainingSeconds = posSub.trialEndsAt
          ? Math.max(0, Math.floor((posSub.trialEndsAt.getTime() - serverNow.getTime()) / 1000))
          : posSub.trialHours * 3600;

        trialData = {
          endsAt: posSub.trialEndsAt ? posSub.trialEndsAt.toISOString() : null,
          serverNow: serverNow.toISOString(),
          remainingSeconds,
        };
      }
    }

    await this.posDevicesService.validateAndRegisterOnLogin(
      { ...user, businessId: targetBusinessId },
      req,
    );

    this.logger.log(`[switchBranch] OK userId=${user.id}, targetBusinessId=${targetBusinessId}`);

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      businessId: targetBusinessId,
      phone: user.phone,
      vehicleType: user.vehicleType,
      vehiclePlate: user.vehiclePlate,
      vehicleColor: user.vehicleColor,
      vehiclePhotoUrl: user.vehiclePhotoUrl,
      profilePhotoUrl: user.profilePhotoUrl,
      isAvailable: user.isAvailable,
      profileComplete: user.profileComplete,
    };

    const tokens = this.generateTokens(payload, maxExpiresAt);

    let businessData: any = null;
    let salonProfile = 'RESTAURANTE';
    let salonLabels = getSalonLabels('RESTAURANTE');
    const bRes = await this.buildBusinessData(targetBusinessId);
    if (bRes) {
      businessData = bRes.businessData;
      salonProfile = bRes.salonProfile;
      salonLabels = bRes.salonLabels;
    }

    const branches = await this.getUserBranches(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        businessId: targetBusinessId,
        phone: user.phone,
        vehicleType: user.vehicleType,
        vehiclePlate: user.vehiclePlate,
        vehicleColor: user.vehicleColor,
        vehiclePhotoUrl: user.vehiclePhotoUrl,
        profilePhotoUrl: user.profilePhotoUrl,
        isAvailable: user.isAvailable,
        profileComplete: user.profileComplete,
        business: businessData,
        salonProfile,
        salonLabels,
      },
      branches,
      trial: trialData,
    };
  }

  async socialLogin(dto: SocialLoginDto): Promise<TokenResponseDto> {
    try {
      const decodedToken = await this.firebaseService.verifyIdToken(dto.idToken);
      const email = decodedToken.email;
      const name = decodedToken.name || 'Usuario';

      if (!email) {
        throw new BadRequestException('El token de autenticación no contiene un correo electrónico');
      }

      let user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        // Create new user
        user = await this.prisma.user.create({
          data: {
            email,
            name,
            authProvider: AuthProvider[dto.provider],
            role: 'REPARTIDOR',
            profileComplete: false,
            isAvailable: true,
          },
        });
        this.logger.log(`[socialLogin] OK nuevo usuario: ${email} via ${dto.provider}`);
      } else {
        // Update provider if it was email (implicit link) or just allow login
        this.logger.log(`[socialLogin] OK usuario existente: ${email} via ${dto.provider}`);
      }

      const payload: JwtPayload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        businessId: user.businessId,
        phone: user.phone,
        vehicleType: user.vehicleType,
        vehiclePlate: user.vehiclePlate,
        vehicleColor: user.vehicleColor,
        vehiclePhotoUrl: user.vehiclePhotoUrl,
        profilePhotoUrl: user.profilePhotoUrl,
        isAvailable: user.isAvailable,
        profileComplete: user.profileComplete,
      };

      const tokens = this.generateTokens(payload);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          businessId: user.businessId,
          phone: user.phone,
          vehicleType: user.vehicleType,
          vehiclePlate: user.vehiclePlate,
          vehicleColor: user.vehicleColor,
          vehiclePhotoUrl: user.vehiclePhotoUrl,
          profilePhotoUrl: user.profilePhotoUrl,
          isAvailable: user.isAvailable,
          profileComplete: user.profileComplete,
        },
      };

    } catch (error: any) {
      this.logger.error(`[socialLogin] ERROR verificando token: ${error.message}`);
      throw new UnauthorizedException('Token de autenticación inválido');
    }
  }

  async registerRider(dto: RegisterRiderDto): Promise<TokenResponseDto> {
    try {
      let businessId: string | null = null;
      let inviteCodeRecord: any = null;

      if (dto.inviteCode) {
        inviteCodeRecord = await this.prisma.inviteCode.findUnique({
          where: { code: dto.inviteCode.trim().toUpperCase() },
        });

        if (!inviteCodeRecord || !inviteCodeRecord.isActive) {
          throw new BadRequestException('Código de invitación inválido o inactivo');
        }

        if (inviteCodeRecord.expiresAt && new Date() > inviteCodeRecord.expiresAt) {
          throw new BadRequestException('El código de invitación ha expirado');
        }

        if (
          inviteCodeRecord.maxUses &&
          inviteCodeRecord.usedCount >= inviteCodeRecord.maxUses
        ) {
          throw new BadRequestException('El código ha alcanzado el límite de usos');
        }

        businessId = inviteCodeRecord.businessId;
      }

      const passwordHash = await bcrypt.hash(dto.password, 10);

      const user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: dto.email,
            passwordHash,
            name: dto.name,
            phone: dto.phone,
            role: 'REPARTIDOR',
            businessId,
            isAvailable: true,
            vehicleType: dto.vehicleType,
            vehiclePlate: dto.vehiclePlate,
            vehicleColor: dto.vehicleColor,
          },
        });

        if (inviteCodeRecord) {
          await tx.inviteCodeUsage.create({
            data: {
              inviteCodeId: inviteCodeRecord.id,
              riderId: newUser.id,
            },
          });

          await tx.inviteCode.update({
            where: { id: inviteCodeRecord.id },
            data: { usedCount: { increment: 1 } },
          });
        }

        return newUser;
      });

      this.logger.log(
        `[register] OK nuevo repartidor: ${dto.email} → empresa: ${businessId ?? 'independiente'}`,
      );

      const payload: JwtPayload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        businessId: user.businessId,
        phone: user.phone,
        vehicleType: user.vehicleType,
        vehiclePlate: user.vehiclePlate,
        vehicleColor: user.vehicleColor,
        vehiclePhotoUrl: user.vehiclePhotoUrl,
        profilePhotoUrl: user.profilePhotoUrl,
        isAvailable: user.isAvailable,
        profileComplete: user.profileComplete,
      };

      const tokens = this.generateTokens(payload);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          businessId: user.businessId,
          phone: user.phone,
          vehicleType: user.vehicleType,
          vehiclePlate: user.vehiclePlate,
          vehicleColor: user.vehicleColor,
          vehiclePhotoUrl: user.vehiclePhotoUrl,
          profilePhotoUrl: user.profilePhotoUrl,
          isAvailable: user.isAvailable,
          profileComplete: user.profileComplete,
        },
      };
    } catch (error: any) {
      if (error instanceof BadRequestException || error instanceof ConflictException) {
        throw error;
      }
      if (error.code === 'P2002') {
        this.logger.warn(`[register] WARN email ya existe: ${dto.email}`);
        throw new ConflictException('El correo electrónico ya está en uso');
      }
      this.logger.error(`[register] ERROR: ${error.message}`, error.stack);
      throw error;
    }
  }

  async refresh(refreshToken: string): Promise<TokenResponseDto> {
    try {
      const decoded = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      this.logger.log(`[refresh] Intento de refresh — userId=${decoded?.sub}`);

      const user = await this.prisma.user.findUnique({
        where: { id: decoded.sub },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Usuario no válido o inactivo');
      }

      const activeBusinessId = decoded.businessId || user.businessId;

      if (activeBusinessId) {
        const hasAccess = await this.canAccessBusiness(user, activeBusinessId);
        if (!hasAccess) {
          throw new UnauthorizedException({
            statusCode: 401,
            error: 'Unauthorized',
            code: 'BRANCH_ACCESS_REVOKED',
            message: 'El acceso a la sucursal ha sido revocado. Por favor iniciá sesión nuevamente.',
          });
        }
      }

      let posSub: any = null;
      let trialData: { endsAt: string | null; serverNow: string; remainingSeconds: number | null } | null = null;
      let maxExpiresAt: Date | null = null;

      if (activeBusinessId && user.role !== UserRole.SUPERADMIN) {
        posSub = await this.prisma.businessProductSubscription.findUnique({
          where: {
            businessId_productType: {
              businessId: activeBusinessId,
              productType: BusinessProductType.POS,
            },
          },
        });

        if (posSub && posSub.trialHours !== null && posSub.trialHours >= 1) {
          const now = new Date();

          if (posSub.trialEndsAt && now >= posSub.trialEndsAt) {
            const coverage = await resolveBusinessCoverage(this.prisma, activeBusinessId, now);
            if (!coverage.isCovered) {
              this.logger.warn(`[refresh] Rechazado por prueba vencida: businessId=${activeBusinessId}, userId=${user.id}`);
              throw new ForbiddenException({
                statusCode: 403,
                error: 'Forbidden',
                code: 'TRIAL_EXPIRED',
                message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
              });
            }
          }

          if (posSub.trialEndsAt) {
            maxExpiresAt = posSub.trialEndsAt;
          }

          const serverNow = new Date();
          const remainingSeconds = posSub.trialEndsAt
            ? Math.max(0, Math.floor((posSub.trialEndsAt.getTime() - serverNow.getTime()) / 1000))
            : posSub.trialHours * 3600;

          trialData = {
            endsAt: posSub.trialEndsAt ? posSub.trialEndsAt.toISOString() : null,
            serverNow: serverNow.toISOString(),
            remainingSeconds,
          };
        }
      }

      const payload: JwtPayload = {
        sub: user.id,
        email: user.email,
        role: user.role,
        businessId: activeBusinessId || undefined,
        phone: user.phone,
        vehicleType: user.vehicleType,
        vehiclePlate: user.vehiclePlate,
        vehicleColor: user.vehicleColor,
        vehiclePhotoUrl: user.vehiclePhotoUrl,
        profilePhotoUrl: user.profilePhotoUrl,
        isAvailable: user.isAvailable,
        profileComplete: user.profileComplete,
      };

      const tokens = this.generateTokens(payload, maxExpiresAt);

      this.logger.log(`[refresh] OK — userId=${user.id}, businessId=${activeBusinessId}, nuevos tokens generados`);

      let businessData: any = null;
      let salonProfile = 'RESTAURANTE';
      let salonLabels = getSalonLabels('RESTAURANTE');
      if (activeBusinessId) {
        const bRes = await this.buildBusinessData(activeBusinessId);
        if (bRes) {
          businessData = bRes.businessData;
          salonProfile = bRes.salonProfile;
          salonLabels = bRes.salonLabels;
        }
      }

      const branches = await this.getUserBranches(user);

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          businessId: activeBusinessId || user.businessId,
          phone: user.phone,
          vehicleType: user.vehicleType,
          vehiclePlate: user.vehiclePlate,
          vehicleColor: user.vehicleColor,
          vehiclePhotoUrl: user.vehiclePhotoUrl,
          profilePhotoUrl: user.profilePhotoUrl,
          isAvailable: user.isAvailable,
          profileComplete: user.profileComplete,
          business: businessData,
          salonProfile,
          salonLabels,
        },
        branches,
        trial: trialData,
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.warn(`[refresh] WARN — token inválido: ${error.message}`);
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }
  }

  async getProfile(userId: string, activeBusinessId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        businessId: true,
        vehicleType: true,
        vehiclePlate: true,
        vehicleColor: true,
        vehiclePhotoUrl: true,
        profilePhotoUrl: true,
        isAvailable: true,
        profileComplete: true,
        currentLatitude: true,
        currentLongitude: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    let targetBid = user.businessId;
    if (activeBusinessId) {
      const allowed = await this.canAccessBusiness(user, activeBusinessId);
      if (allowed) {
        targetBid = activeBusinessId;
      }
    }

    let businessData: any = null;
    let salonProfile = 'RESTAURANTE';
    let salonLabels = getSalonLabels('RESTAURANTE');

    if (targetBid) {
      const bRes = await this.buildBusinessData(targetBid);
      if (bRes) {
        businessData = bRes.businessData;
        salonProfile = bRes.salonProfile;
        salonLabels = bRes.salonLabels;
      }
    }

    const branches = await this.getUserBranches(user);

    return {
      ...user,
      businessId: targetBid || user.businessId,
      salonProfile,
      salonLabels,
      business: businessData,
      branches,
    };
  }

  private parseDurationToSeconds(duration?: string | null): number {
    if (!duration) return 86400;
    if (/^\d+$/.test(duration)) return parseInt(duration, 10);
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) return 86400;
    const val = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === 's') return val;
    if (unit === 'm') return val * 60;
    if (unit === 'h') return val * 3600;
    if (unit === 'd') return val * 86400;
    return 86400;
  }

  private generateTokens(payload: JwtPayload, maxExpiresAt?: Date | null): { accessToken: string; refreshToken: string } {
    let accessExpiresIn: number | string | undefined = undefined;
    let refreshExpiresIn: number | string | undefined = this.configService.get<string>('JWT_REFRESH_EXPIRATION');

    if (maxExpiresAt) {
      const nowMs = Date.now();
      const remainingSec = Math.max(1, Math.floor((maxExpiresAt.getTime() - nowMs) / 1000));

      const defaultAccessExp = this.configService.get<string>('JWT_EXPIRATION') || '1d';
      const defaultAccessSec = this.parseDurationToSeconds(defaultAccessExp);
      accessExpiresIn = Math.min(defaultAccessSec, remainingSec);

      const defaultRefreshExp = this.configService.get<string>('JWT_REFRESH_EXPIRATION') || '7d';
      const defaultRefreshSec = this.parseDurationToSeconds(defaultRefreshExp);
      refreshExpiresIn = Math.min(defaultRefreshSec, remainingSec);
    }

    const accessToken = this.jwtService.sign(payload, accessExpiresIn ? { expiresIn: accessExpiresIn } : undefined);

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresIn,
    });

    return { accessToken, refreshToken };
  }
}

