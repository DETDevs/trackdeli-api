import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductsService } from '../business-products/business-products.service';
import { BookingEmailService } from './booking-email.service';
import {
  AppointmentStatus,
  BusinessProductType,
  Prisma,
} from '@prisma/client';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import {
  CreateBookingServiceDto,
  UpdateBookingServiceDto,
} from './dto/booking-service.dto';
import {
  CreateSpecialistDto,
  UpdateSpecialistDto,
} from './dto/specialist.dto';
import {
  CreateProfessionDto,
  UpdateProfessionDto,
} from './dto/profession.dto';
import { SaveSchedulesDto } from './dto/save-schedules.dto';
import { UpdateBookingSettingsDto } from './dto/update-booking-settings.dto';
import { v4 as uuidv4 } from 'uuid';
import { UUID_REGEX } from '../../common/utils/slug.util';

export const BOOKING_TIMEZONE = 'America/Managua';
export const BOOKING_TZ_OFFSET = '-06:00';

@Injectable()
export class BookingService implements OnModuleInit {
  private readonly logger = new Logger(BookingService.name);

  async onModuleInit() {
    try {
      const oldApps = await this.prisma.appointment.findMany({
        where: {
          scheduledAt: new Date('2026-09-18T09:00:00.000Z'),
        },
      });
      for (const app of oldApps) {
        await this.prisma.appointment.update({
          where: { id: app.id },
          data: { scheduledAt: new Date('2026-09-18T15:00:00.000Z') },
        });
        this.logger.log(`[TimezoneCorrection] Updated appointment ${app.id} to 15:00:00.000Z (09:00 local)`);
      }
    } catch (err) {
      this.logger.warn('[TimezoneCorrection] Could not auto-correct legacy appointment:', err);
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
    private readonly emailService: BookingEmailService,
  ) {}

  /**
   * Valida que el negocio tenga contratado y activo el producto CITAS.
   */
  async assertCitasActive(businessId: string): Promise<void> {
    const isActive = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CITAS,
    );
    if (!isActive) {
      throw new ForbiddenException(
        'El módulo de Citas no está contratado ni activo para este negocio',
      );
    }
  }

  /**
   * Catálogo público de servicios activos del negocio.
   */
  /**
   * Resuelve un negocio por UUID o por slug legible.
   * Da prioridad a búsqueda por ID si coincide con formato UUID,
   * luego busca por slug, asegurando retrocompatibilidad total.
   */
  async resolveBusiness(businessIdOrSlug: string) {
    if (!businessIdOrSlug) {
      throw new NotFoundException('Identificador de negocio no proporcionado');
    }

    const trimmed = businessIdOrSlug.trim();

    if (UUID_REGEX.test(trimmed)) {
      const byId = await this.prisma.business.findUnique({
        where: { id: trimmed },
      });
      if (byId) return byId;
    }

    const bySlug = await this.prisma.business.findUnique({
      where: { slug: trimmed.toLowerCase() },
    });
    if (bySlug) return bySlug;

    throw new NotFoundException('Negocio no encontrado');
  }

  /**
   * Información pública del negocio.
   */
  async getPublicBusinessInfo(businessIdOrSlug: string) {
    const business = await this.resolveBusiness(businessIdOrSlug);
    await this.assertCitasActive(business.id);

    return {
      id: business.id,
      name: business.name,
      slug: business.slug,
      logoUrl: business.logoUrl,
      posAddress: business.posAddress,
      whatsappNumber: business.whatsappNumber,
      posPhone: business.posPhone,
    };
  }

  async getPublicServices(businessIdOrSlug: string) {
    const business = await this.resolveBusiness(businessIdOrSlug);
    await this.assertCitasActive(business.id);
    const businessId = business.id;

    const services = await this.prisma.service.findMany({
      where: {
        businessId,
        active: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        durationMinutes: true,
        price: true,
        hasCustomSchedule: true,
        active: true,
        specialists: {
          select: {
            specialist: {
              select: {
                id: true,
                name: true,
                specialty: true,
                active: true,
                profession: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    return services.map((s) => {
      const activeSpecialists = s.specialists
        .filter((ss) => ss.specialist.active)
        .map((ss) => ({
          ...ss.specialist,
          specialty: ss.specialist.profession?.name ?? ss.specialist.specialty ?? '',
        }));
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        durationMinutes: s.durationMinutes,
        price: s.price,
        hasCustomSchedule: s.hasCustomSchedule,
        active: s.active,
        isActive: s.active,
        specialists: activeSpecialists,
        specialistId: activeSpecialists[0]?.id ?? null,
        specialist: activeSpecialists[0] ?? null,
      };
    });
  }

  /**
   * Construye el criterio de filtrado de citas en conflicto para un servicio / especialista:
   * - Si hay specialistId: busca citas de ese especialista independientemente del servicio.
   * - Si no hay specialistId (servicio genérico): busca citas exclusivamente del mismo servicio sin especialista.
   */
  private buildConflictWhereClause(
    businessId: string,
    params: { serviceId: string; specialistId?: string | null },
    extraWhere?: Prisma.AppointmentWhereInput,
  ): Prisma.AppointmentWhereInput {
    return {
      businessId,
      status: {
        in: [
          AppointmentStatus.PENDING,
          AppointmentStatus.CONFIRMED,
          AppointmentStatus.COMPLETED,
          AppointmentStatus.NO_SHOW,
        ],
      },
      ...(params.specialistId
        ? { specialistId: params.specialistId }
        : { serviceId: params.serviceId, specialistId: null }),
      ...extraWhere,
    };
  }

  /**
   * Chequea si existe alguna cita en conflicto para un intervalo [scheduledAt, scheduledAt + durationMinutes).
   */
  async hasConflictingAppointment(
    prismaOrTx: Prisma.TransactionClient | PrismaService,
    params: {
      businessId: string;
      serviceId: string;
      specialistId?: string | null;
      scheduledAt: Date;
      durationMinutes: number;
      excludeAppointmentId?: string;
    },
  ): Promise<boolean> {
    const {
      businessId,
      serviceId,
      specialistId,
      scheduledAt,
      durationMinutes,
      excludeAppointmentId,
    } = params;
    const scheduledEnd = new Date(
      scheduledAt.getTime() + durationMinutes * 60 * 1000,
    );

    const where = this.buildConflictWhereClause(
      businessId,
      { serviceId, specialistId },
      {
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        scheduledAt: { lt: scheduledEnd },
      },
    );

    const candidates = await prismaOrTx.appointment.findMany({
      where,
      select: {
        id: true,
        scheduledAt: true,
        durationMinutes: true,
      },
    });

    return candidates.some((app) => {
      const appStart = new Date(app.scheduledAt).getTime();
      const appEnd = appStart + app.durationMinutes * 60 * 1000;
      return (
        scheduledAt.getTime() < appEnd && scheduledEnd.getTime() > appStart
      );
    });
  }

  /**
   * Motor de cálculo de disponibilidad de slots.
   */
  async getAvailability(
    businessIdOrSlug: string,
    serviceId: string,
    dateStr: string,
    requestedSpecialistId?: string,
  ) {
    const business = await this.resolveBusiness(businessIdOrSlug);
    await this.assertCitasActive(business.id);
    const businessId = business.id;

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, businessId, active: true },
      include: {
        specialists: {
          include: {
            specialist: true,
          },
        },
      },
    });

    if (!service) {
      throw new NotFoundException('Servicio no encontrado o inactivo');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('El formato de fecha debe ser YYYY-MM-DD');
    }

    const assignedSpecialists = service.specialists
      .filter((s) => s.specialist.active)
      .map((s) => s.specialist);

    if (requestedSpecialistId) {
      const isAssigned = assignedSpecialists.some((s) => s.id === requestedSpecialistId);
      if (!isAssigned) {
        throw new BadRequestException('El especialista no está asignado a este servicio');
      }
    }

    const [year, month, day] = dateStr.split('-').map(Number);
    const dayDate = new Date(Date.UTC(year, month - 1, day));
    const dayOfWeek = dayDate.getUTCDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado

    // 1. Resolver el horario base (override por servicio si hasCustomSchedule es true; si no, horario general)
    let schedules = [];
    if (service.hasCustomSchedule) {
      schedules = await this.prisma.availabilitySchedule.findMany({
        where: {
          businessId,
          serviceId: service.id,
          dayOfWeek,
        },
        orderBy: { startTime: 'asc' },
      });
    } else {
      schedules = await this.prisma.availabilitySchedule.findMany({
        where: {
          businessId,
          serviceId: null,
          dayOfWeek,
        },
        orderBy: { startTime: 'asc' },
      });
    }

    if (!schedules.length) {
      return {
        date: dateStr,
        dayOfWeek,
        service: {
          id: service.id,
          name: service.name,
          durationMinutes: service.durationMinutes,
        },
        availableSlots: [],
      };
    }

    // 2. Citas existentes en esa fecha
    const dayStart = new Date(`${dateStr}T00:00:00.000${BOOKING_TZ_OFFSET}`);
    const dayEnd = new Date(`${dateStr}T23:59:59.999${BOOKING_TZ_OFFSET}`);

    const existingAppointments = await this.prisma.appointment.findMany({
      where: {
        businessId,
        status: {
          in: [
            AppointmentStatus.PENDING,
            AppointmentStatus.CONFIRMED,
            AppointmentStatus.COMPLETED,
            AppointmentStatus.NO_SHOW,
          ],
        },
        scheduledAt: {
          gte: dayStart,
          lte: dayEnd,
        },
      },
      select: {
        id: true,
        serviceId: true,
        specialistId: true,
        scheduledAt: true,
        durationMinutes: true,
      },
    });

    const now = new Date();
    const availableSlots: Array<{
      startTime: string;
      endTime: string;
      scheduledAt: string;
    }> = [];

    // 3. Generar slots posibles dentro de cada ventana de horario
    for (const sched of schedules) {
      const [startH, startM] = sched.startTime.split(':').map(Number);
      const [endH, endM] = sched.endTime.split(':').map(Number);

      let currentMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;

      while (currentMin + service.durationMinutes <= endMin) {
        const slotStartH = Math.floor(currentMin / 60);
        const slotStartM = currentMin % 60;
        const slotEndMin = currentMin + service.durationMinutes;
        const slotEndH = Math.floor(slotEndMin / 60);
        const slotEndM = slotEndMin % 60;

        const slotStartHStr = String(slotStartH).padStart(2, '0');
        const slotStartMStr = String(slotStartM).padStart(2, '0');
        const slotEndHStr = String(slotEndH).padStart(2, '0');
        const slotEndMStr = String(slotEndM).padStart(2, '0');

        const slotStartTimeStr = `${slotStartHStr}:${slotStartMStr}`;
        const slotEndTimeStr = `${slotEndHStr}:${slotEndMStr}`;

        const slotStartDate = new Date(`${dateStr}T${slotStartTimeStr}:00${BOOKING_TZ_OFFSET}`);
        const slotEndDate = new Date(`${dateStr}T${slotEndTimeStr}:00${BOOKING_TZ_OFFSET}`);

        if (slotStartDate.getTime() > now.getTime()) {
          const slotStartMs = slotStartDate.getTime();
          const slotEndMs = slotEndDate.getTime();

          let isSlotAvailable = false;

          if (assignedSpecialists.length > 0) {
            if (requestedSpecialistId) {
              const hasConflict = existingAppointments.some((app) => {
                if (app.specialistId !== requestedSpecialistId) return false;
                const appStart = new Date(app.scheduledAt).getTime();
                const appEnd = appStart + app.durationMinutes * 60 * 1000;
                return slotStartMs < appEnd && slotEndMs > appStart;
              });
              isSlotAvailable = !hasConflict;
            } else {
              // Disponible si al menos un especialista asignado está libre
              const freeSpecialists = assignedSpecialists.filter((spec) => {
                const hasConflict = existingAppointments.some((app) => {
                  if (app.specialistId !== spec.id) return false;
                  const appStart = new Date(app.scheduledAt).getTime();
                  const appEnd = appStart + app.durationMinutes * 60 * 1000;
                  return slotStartMs < appEnd && slotEndMs > appStart;
                });
                return !hasConflict;
              });
              isSlotAvailable = freeSpecialists.length > 0;
            }
          } else {
            // Servicio genérico sin especialistas asignados
            const hasConflict = existingAppointments.some((app) => {
              if (app.serviceId !== service.id || app.specialistId !== null) return false;
              const appStart = new Date(app.scheduledAt).getTime();
              const appEnd = appStart + app.durationMinutes * 60 * 1000;
              return slotStartMs < appEnd && slotEndMs > appStart;
            });
            isSlotAvailable = !hasConflict;
          }

          if (isSlotAvailable) {
            availableSlots.push({
              startTime: slotStartTimeStr,
              endTime: slotEndTimeStr,
              scheduledAt: slotStartDate.toISOString(),
            });
          }
        }

        currentMin += service.durationMinutes;
      }
    }

    return {
      date: dateStr,
      dayOfWeek,
      service: {
        id: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
      },
      availableSlots,
    };
  }

  /**
   * Crear reserva pública.
   */
  async createAppointment(businessIdOrSlug: string, dto: CreateAppointmentDto) {
    const business = await this.resolveBusiness(businessIdOrSlug);
    await this.assertCitasActive(business.id);
    const businessId = business.id;

    const service = await this.prisma.service.findFirst({
      where: { id: dto.serviceId, businessId, active: true },
      include: {
        specialists: {
          include: {
            specialist: true,
          },
        },
      },
    });
    if (!service) {
      throw new NotFoundException('Servicio no encontrado o inactivo');
    }

    const scheduledAt = new Date(dto.scheduledAt);
    if (isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Fecha y hora inválida');
    }
    if (scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('La fecha y hora de la cita debe ser futura');
    }

    const cleanPhone = dto.customerPhone.trim();
    if (!cleanPhone) {
      throw new BadRequestException('El teléfono del cliente es requerido');
    }

    // Resolver especialistas válidos
    const activeSpecialists = service.specialists
      .filter((s) => s.specialist.active)
      .map((s) => s.specialist);

    let targetSpecialistId: string | null = null;

    if (activeSpecialists.length === 0) {
      if (dto.specialistId) {
        throw new BadRequestException('Este servicio no tiene especialistas asignables');
      }
      targetSpecialistId = null;
    } else {
      if (dto.specialistId) {
        const found = activeSpecialists.find((s) => s.id === dto.specialistId);
        if (!found) {
          throw new BadRequestException(
            'El especialista seleccionado no está asignado a este servicio',
          );
        }
        targetSpecialistId = dto.specialistId;
      }
    }

    // Buscar o crear Customer por (businessId, phone)
    let customer = await this.prisma.customer.findUnique({
      where: {
        businessId_phone: {
          businessId,
          phone: cleanPhone,
        },
      },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          businessId,
          phone: cleanPhone,
          name: dto.customerName.trim(),
          email: dto.customerEmail?.trim() || null,
        },
      });
    } else {
      // 75a: Fix: El nombre del Customer queda fijo tras la primera vez que se crea.
      // Nunca se sobreescribe automáticamente desde una reserva pública nueva.
      // Customer.email solo se completa si estaba vacío/null y ahora sí se proporciona uno válido.
      const candidateEmail = dto.customerEmail?.trim();
      if (!customer.email?.trim() && candidateEmail) {
        customer = await this.prisma.customer.update({
          where: { id: customer.id },
          data: { email: candidateEmail },
        });
      }
    }

    if (customer.isBlocked) {
      throw new ForbiddenException(
        'El cliente se encuentra bloqueado para realizar reservas debido a inasistencias previas (no-shows). Contacte al negocio directamente.',
      );
    }

    const durationMinutes = service.durationMinutes;
    const manageToken = uuidv4();

    // Re-validación atómica dentro de transacción
    const appointment = await this.prisma.$transaction(async (tx) => {
      let resolvedSpecialistId = targetSpecialistId;

      if (activeSpecialists.length > 0 && !resolvedSpecialistId) {
        // Auto-asignar al primer especialista libre en ese horario
        for (const spec of activeSpecialists) {
          const conflict = await this.hasConflictingAppointment(tx, {
            businessId,
            serviceId: service.id,
            specialistId: spec.id,
            scheduledAt,
            durationMinutes,
          });
          if (!conflict) {
            resolvedSpecialistId = spec.id;
            break;
          }
        }

        if (!resolvedSpecialistId) {
          throw new ConflictException(
            'El horario seleccionado ya no se encuentra disponible. Por favor elija otro horario.',
          );
        }
      } else {
        const hasConflict = await this.hasConflictingAppointment(tx, {
          businessId,
          serviceId: service.id,
          specialistId: resolvedSpecialistId,
          scheduledAt,
          durationMinutes,
        });

        if (hasConflict) {
          throw new ConflictException(
            'El horario seleccionado ya no se encuentra disponible. Por favor elija otro horario.',
          );
        }
      }

      const newApp = await tx.appointment.create({
        data: {
          businessId,
          serviceId: service.id,
          specialistId: resolvedSpecialistId,
          customerId: customer.id,
          scheduledAt,
          durationMinutes,
          capacity: 1,
          status: AppointmentStatus.PENDING,
          price: service.price,
          customerName: dto.customerName.trim(),
          customerPhone: cleanPhone,
          customerEmail: dto.customerEmail?.trim() || null,
          manageToken,
          rescheduleCount: 0,
        },
        include: {
          service: true,
          specialist: true,
          customer: true,
          business: true,
        },
      });

      return newApp;
    });

    return appointment;
  }

  /**
   * Obtener detalle de cita mediante token único (autogestión).
   */
  async getAppointmentByToken(token: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { manageToken: token },
      include: {
        service: true,
        customer: true,
        business: {
          select: {
            id: true,
            name: true,
            posAddress: true,
            whatsappNumber: true,
            posPhone: true,
          },
        },
      },
    });

    if (!appointment) {
      throw new NotFoundException('Cita no encontrada con el token proporcionado');
    }

    await this.assertCitasActive(appointment.businessId);

    return appointment;
  }

  /**
   * Cancelación de cita por el cliente mediante token (con bloqueo por minCancellationHours).
   */
  async cancelAppointmentByToken(token: string) {
    const appointment = await this.getAppointmentByToken(token);

    if (appointment.status === AppointmentStatus.CANCELLED) {
      throw new BadRequestException('La cita ya se encuentra cancelada');
    }
    if (appointment.status === AppointmentStatus.COMPLETED) {
      throw new BadRequestException('No se puede cancelar una cita completada');
    }

    const settings = await this.getOrCreateSettings(appointment.businessId);
    const msUntilAppointment = new Date(appointment.scheduledAt).getTime() - Date.now();
    const hoursUntilAppointment = msUntilAppointment / (1000 * 60 * 60);

    if (hoursUntilAppointment < settings.minCancellationHours) {
      throw new ForbiddenException(
        'Esta cita está muy próxima para cancelarla vos mismo. Contactá al negocio directamente por WhatsApp para solicitar la cancelación.',
      );
    }

    const updated = await this.prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        status: AppointmentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: 'Cancelada por el cliente desde portal de autogestión',
      },
      include: {
        service: true,
        customer: true,
        business: true,
      },
    });

    return {
      message: 'Tu cita ha sido cancelada exitosamente.',
      appointment: updated,
    };
  }

  /**
   * Reagendamiento de cita por el cliente mediante token (máximo 1 vez, bloquea en ventana mínima).
   */
  async rescheduleAppointmentByToken(token: string, newScheduledAtStr: string) {
    const appointment = await this.getAppointmentByToken(token);

    if (
      appointment.status === AppointmentStatus.CANCELLED ||
      appointment.status === AppointmentStatus.COMPLETED
    ) {
      throw new BadRequestException(
        'No se puede reagendar una cita cancelada o completada',
      );
    }

    if (appointment.rescheduleCount >= 1) {
      throw new ForbiddenException(
        'Ya reagendaste esta cita una vez. Para otro cambio, contactá al negocio por WhatsApp.',
      );
    }

    const settings = await this.getOrCreateSettings(appointment.businessId);
    const msUntilCurrent = new Date(appointment.scheduledAt).getTime() - Date.now();
    const hoursUntilCurrent = msUntilCurrent / (1000 * 60 * 60);

    if (hoursUntilCurrent < settings.minCancellationHours) {
      throw new ForbiddenException(
        'Esta cita está muy próxima para reagendarla vos mismo. Contactá al negocio directamente por WhatsApp.',
      );
    }

    const newScheduledAt = new Date(newScheduledAtStr);
    if (isNaN(newScheduledAt.getTime()) || newScheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('La nueva fecha y hora debe ser válida y futura');
    }

    const durationMinutes = appointment.durationMinutes;
    const newScheduledEnd = new Date(newScheduledAt.getTime() + durationMinutes * 60 * 1000);

    // Transacción atómica para verificar disponibilidad del nuevo slot
    const updated = await this.prisma.$transaction(async (tx) => {
      const hasConflict = await this.hasConflictingAppointment(tx, {
        businessId: appointment.businessId,
        serviceId: appointment.serviceId,
        specialistId: appointment.specialistId,
        scheduledAt: newScheduledAt,
        durationMinutes,
        excludeAppointmentId: appointment.id,
      });

      if (hasConflict) {
        throw new ConflictException(
          'El nuevo horario seleccionado ya no se encuentra disponible. Por favor elige otro.',
        );
      }

      return tx.appointment.update({
        where: { id: appointment.id },
        data: {
          scheduledAt: newScheduledAt,
          rescheduleCount: appointment.rescheduleCount + 1,
          status: AppointmentStatus.PENDING, // Siempre vuelve a PENDING
          confirmedAt: null,
        },
        include: {
          service: true,
          specialist: true,
          customer: true,
          business: true,
        },
      });
    });

    if (updated.customerEmail) {
      this.emailService
        .sendBookingReceipt({
          to: updated.customerEmail,
          businessName: updated.business.name,
          serviceName: updated.service.name,
          scheduledAt: updated.scheduledAt,
          durationMinutes: updated.durationMinutes,
          price: updated.price,
          address: updated.business.posAddress,
          manageToken: updated.manageToken,
          status: updated.status,
        })
        .catch((err) =>
          this.logger.warn(`Error enviando correo de cita reagendada: ${err.message}`),
        );
    }

    return {
      message: 'Cita reagendada exitosamente. Pendiente de nueva aprobación por el negocio.',
      appointment: updated,
    };
  }

  // =========================================================================
  // Endpoints del Panel del Negocio (Autenticados)
  // =========================================================================

  /**
   * Listado/Agenda de citas del negocio con filtros.
   */
  async getBusinessAppointments(
    businessId: string,
    filters?: {
      status?: AppointmentStatus;
      date?: string;
      serviceId?: string;
      specialistId?: string;
      page?: number;
      limit?: number;
    },
  ) {
    await this.assertCitasActive(businessId);

    const page = Math.max(1, Number(filters?.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters?.limit) || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.AppointmentWhereInput = {
      businessId,
    };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.specialistId) {
      where.specialistId = filters.specialistId;
    }
    if (filters?.serviceId) {
      where.serviceId = filters.serviceId;
    }

    if (filters?.date) {
      const dayStart = new Date(`${filters.date}T00:00:00.000${BOOKING_TZ_OFFSET}`);
      const dayEnd = new Date(`${filters.date}T23:59:59.999${BOOKING_TZ_OFFSET}`);
      where.scheduledAt = {
        gte: dayStart,
        lte: dayEnd,
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        skip,
        take: limit,
        include: {
          service: true,
          specialist: true,
          customer: true,
        },
        orderBy: {
          scheduledAt: 'asc',
        },
      }),
      this.prisma.appointment.count({ where }),
    ]);

    const mappedItems = items.map((app) => ({
      ...app,
      service: app.service
        ? {
            ...app.service,
            specialist: app.specialist ?? null,
            specialistId: app.specialistId ?? null,
          }
        : null,
    }));

    return {
      items: mappedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Aprobar cita (pasa a CONFIRMED, genera enlace wa.me y actualiza email).
   */
  async approveAppointment(appointmentId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        business: true,
        service: true,
        customer: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Cita no encontrada');
    }

    await this.assertCitasActive(appointment.businessId);

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.CONFIRMED,
        confirmedAt: new Date(),
      },
      include: {
        business: true,
        service: true,
        customer: true,
      },
    });

    // Generar link de WhatsApp pre-armado
    const formattedDate = new Intl.DateTimeFormat('es-NI', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(updated.scheduledAt));

    const text = `¡Hola ${updated.customer.name}! Te confirmamos tu cita para *${updated.service.name}* el *${formattedDate}* en *${updated.business.name}*. ¡Te esperamos!`;
    const cleanPhone = updated.customer.phone.replace(/\D/g, '');
    const whatsappUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`;

    if (updated.customerEmail) {
      if (!updated.confirmationEmailSentAt) {
        this.emailService
          .sendBookingReceipt({
            to: updated.customerEmail,
            businessName: updated.business.name,
            serviceName: updated.service.name,
            scheduledAt: updated.scheduledAt,
            durationMinutes: updated.durationMinutes,
            price: updated.price,
            address: updated.business.posAddress,
            manageToken: updated.manageToken,
            status: AppointmentStatus.CONFIRMED,
          })
          .then(async (success) => {
            if (success) {
              await this.prisma.appointment.update({
                where: { id: appointmentId },
                data: { confirmationEmailSentAt: new Date() },
              });
              this.logger.log(
                `[BookingService] ✓ Correo de confirmación enviado y registrado para cita ${appointmentId} a ${updated.customerEmail}`,
              );
            }
          })
          .catch((err) =>
            this.logger.warn(`Error enviando correo de confirmación: ${err.message}`),
          );
      } else {
        this.logger.log(
          `[BookingService] Correo de confirmación omitido por idempotencia (ya enviado en ${updated.confirmationEmailSentAt}) para cita ${appointmentId}`,
        );
      }
    }

    return {
      appointment: updated,
      whatsappUrl,
    };
  }

  /**
   * Rechazar cita (antes de aprobar).
   */
  async declineAppointment(appointmentId: string, reason?: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Cita no encontrada');
    }

    await this.assertCitasActive(appointment.businessId);

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: reason || 'Rechazada por el negocio',
      },
      include: {
        service: true,
        customer: true,
      },
    });

    return updated;
  }

  /**
   * Cancelar cita confirmada por el negocio.
   * Si está dentro de minCancellationHours, no bloquea: advierte con lateCancellation: true.
   */
  async cancelAppointmentByBusiness(appointmentId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Cita no encontrada');
    }

    await this.assertCitasActive(appointment.businessId);

    const settings = await this.getOrCreateSettings(appointment.businessId);
    const msUntilAppointment = new Date(appointment.scheduledAt).getTime() - Date.now();
    const hoursUntilAppointment = msUntilAppointment / (1000 * 60 * 60);

    const isLateCancellation = hoursUntilAppointment < settings.minCancellationHours;

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: 'Cancelada por el negocio',
      },
      include: {
        service: true,
        customer: true,
      },
    });

    return {
      appointment: updated,
      lateCancellation: isLateCancellation,
      warning: isLateCancellation
        ? `Cancelación tardía: la cita estaba programada dentro de la ventana mínima (${settings.minCancellationHours} horas).`
        : null,
    };
  }

  /**
   * Marcar cita como completada (resetea racha de no-shows).
   */
  async completeAppointment(appointmentId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Cita no encontrada');
    }

    await this.assertCitasActive(appointment.businessId);

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.COMPLETED,
        completedAt: new Date(),
      },
      include: {
        service: true,
        customer: true,
      },
    });

    // Resetear contador de inasistencias consecutivas del cliente
    await this.prisma.customer.update({
      where: { id: appointment.customerId },
      data: {
        consecutiveNoShows: 0,
      },
    });

    return updated;
  }

  /**
   * Marcar cita como no-show.
   * Si trackNoShows está activo, incrementa contador y auto-bloquea si alcanza el umbral.
   */
  async markNoShow(appointmentId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { customer: true },
    });

    if (!appointment) {
      throw new NotFoundException('Cita no encontrada');
    }

    await this.assertCitasActive(appointment.businessId);

    const settings = await this.getOrCreateSettings(appointment.businessId);

    const updatedApp = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.NO_SHOW,
      },
      include: {
        service: true,
        customer: true,
      },
    });

    let autoBlocked = false;
    let newConsecutiveNoShows = appointment.customer.consecutiveNoShows;

    if (settings.trackNoShows) {
      newConsecutiveNoShows += 1;
      const shouldBlock =
        settings.autoBlockAfterNoShows &&
        newConsecutiveNoShows >= settings.noShowThreshold;

      await this.prisma.customer.update({
        where: { id: appointment.customerId },
        data: {
          consecutiveNoShows: newConsecutiveNoShows,
          ...(shouldBlock ? { isBlocked: true } : {}),
        },
      });

      autoBlocked = shouldBlock;
    }

    return {
      appointment: updatedApp,
      consecutiveNoShows: newConsecutiveNoShows,
      autoBlocked,
    };
  }

  // =========================================================================
  // Configuración del Negocio: Servicios, Horarios, Ajustes
  // =========================================================================

  async getServices(businessId: string) {
    await this.assertCitasActive(businessId);
    const services = await this.prisma.service.findMany({
      where: { businessId },
      include: {
        specialists: {
          include: {
            specialist: {
              select: {
                id: true,
                name: true,
                specialty: true,
                active: true,
                profession: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return services.map((s) => {
      const activeSpecialists = s.specialists
        .filter((ss) => ss.specialist.active)
        .map((ss) => ({
          ...ss.specialist,
          specialty: ss.specialist.profession?.name ?? ss.specialist.specialty ?? '',
        }));
      return {
        ...s,
        isActive: s.active,
        specialists: activeSpecialists,
        specialistId: activeSpecialists[0]?.id ?? null,
        specialist: activeSpecialists[0] ?? null,
      };
    });
  }

  async createService(businessId: string, dto: CreateBookingServiceDto) {
    await this.assertCitasActive(businessId);

    const rawIds = dto.specialistIds ?? (dto.specialistId ? [dto.specialistId] : []);
    const specialistIds = Array.from(new Set(rawIds.filter(Boolean)));

    if (specialistIds.length > 0) {
      const count = await this.prisma.specialist.count({
        where: { id: { in: specialistIds }, businessId },
      });
      if (count !== specialistIds.length) {
        throw new BadRequestException(
          'Uno o más especialistas no existen o no pertenecen a este negocio',
        );
      }
    }

    const active = dto.active ?? dto.isActive ?? true;

    const created = await this.prisma.service.create({
      data: {
        businessId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        durationMinutes: dto.durationMinutes,
        price: dto.price,
        active,
        hasCustomSchedule: dto.hasCustomSchedule ?? false,
        specialists: {
          create: specialistIds.map((specId) => ({
            specialistId: specId,
          })),
        },
      },
      include: {
        specialists: {
          include: {
            specialist: {
              select: {
                id: true,
                name: true,
                specialty: true,
                active: true,
                profession: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const activeSpecialists = created.specialists
      .filter((ss) => ss.specialist.active)
      .map((ss) => ({
        ...ss.specialist,
        specialty: ss.specialist.profession?.name ?? ss.specialist.specialty ?? '',
      }));

    return {
      ...created,
      isActive: created.active,
      specialists: activeSpecialists,
      specialistId: activeSpecialists[0]?.id ?? null,
      specialist: activeSpecialists[0] ?? null,
    };
  }

  async updateService(serviceId: string, dto: UpdateBookingServiceDto) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
    });
    if (!service) {
      throw new NotFoundException('Servicio no encontrado');
    }
    await this.assertCitasActive(service.businessId);

    const rawIds =
      dto.specialistIds ??
      (dto.specialistId !== undefined
        ? dto.specialistId
          ? [dto.specialistId]
          : []
        : undefined);

    let specialistIds: string[] | undefined = undefined;
    if (rawIds !== undefined) {
      specialistIds = Array.from(new Set(rawIds.filter(Boolean)));
      if (specialistIds.length > 0) {
        const count = await this.prisma.specialist.count({
          where: { id: { in: specialistIds }, businessId: service.businessId },
        });
        if (count !== specialistIds.length) {
          throw new BadRequestException(
            'Uno o más especialistas no existen o no pertenecen a este negocio',
          );
        }
      }
    }

    const active = dto.active ?? dto.isActive;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (specialistIds !== undefined) {
        await tx.serviceSpecialist.deleteMany({
          where: { serviceId },
        });
        if (specialistIds.length > 0) {
          await tx.serviceSpecialist.createMany({
            data: specialistIds.map((specId) => ({
              serviceId,
              specialistId: specId,
            })),
          });
        }
      }

      return tx.service.update({
        where: { id: serviceId },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.description !== undefined && {
            description: dto.description?.trim() || null,
          }),
          ...(dto.durationMinutes !== undefined && {
            durationMinutes: dto.durationMinutes,
          }),
          ...(dto.price !== undefined && { price: dto.price }),
          ...(active !== undefined && { active }),
          ...(dto.hasCustomSchedule !== undefined && {
            hasCustomSchedule: dto.hasCustomSchedule,
          }),
        },
        include: {
          specialists: {
            include: {
              specialist: {
                select: {
                  id: true,
                  name: true,
                  specialty: true,
                  active: true,
                  profession: {
                    select: {
                      id: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
    });

    const activeSpecialists = updated.specialists
      .filter((ss) => ss.specialist.active)
      .map((ss) => ({
        ...ss.specialist,
        specialty: ss.specialist.profession?.name ?? ss.specialist.specialty ?? '',
      }));

    return {
      ...updated,
      isActive: updated.active,
      specialists: activeSpecialists,
      specialistId: activeSpecialists[0]?.id ?? null,
      specialist: activeSpecialists[0] ?? null,
    };
  }

  async deleteService(serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
    });
    if (!service) {
      throw new NotFoundException('Servicio no encontrado');
    }
    await this.assertCitasActive(service.businessId);

    // Soft delete para mantener integridad histórica de citas
    return this.prisma.service.update({
      where: { id: serviceId },
      data: { active: false },
    });
  }

  async getSchedules(businessId: string, serviceId?: string) {
    await this.assertCitasActive(businessId);
    return this.prisma.availabilitySchedule.findMany({
      where: {
        businessId,
        serviceId: serviceId || null,
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  async saveSchedules(businessId: string, dto: SaveSchedulesDto) {
    await this.assertCitasActive(businessId);

    const targetServiceId = dto.serviceId || null;
    if (targetServiceId) {
      const service = await this.prisma.service.findFirst({
        where: { id: targetServiceId, businessId },
      });
      if (!service) {
        throw new NotFoundException('Servicio especificado no encontrado');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Eliminar horarios anteriores para este ámbito (general o por servicio)
      await tx.availabilitySchedule.deleteMany({
        where: {
          businessId,
          serviceId: targetServiceId,
        },
      });

      // Crear nuevos horarios
      if (dto.schedules && dto.schedules.length > 0) {
        await tx.availabilitySchedule.createMany({
          data: dto.schedules.map((s) => ({
            businessId,
            serviceId: targetServiceId,
            dayOfWeek: s.dayOfWeek,
            startTime: s.startTime,
            endTime: s.endTime,
          })),
        });
      }

      return tx.availabilitySchedule.findMany({
        where: {
          businessId,
          serviceId: targetServiceId,
        },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      });
    });
  }

  async getOrCreateSettings(businessId: string) {
    let settings = await this.prisma.businessBookingSettings.findUnique({
      where: { businessId },
    });

    if (!settings) {
      settings = await this.prisma.businessBookingSettings.create({
        data: {
          businessId,
          minCancellationHours: 2,
          trackNoShows: false,
          autoBlockAfterNoShows: false,
          noShowThreshold: 3,
        },
      });
    }

    return settings;
  }

  async getSettings(businessId: string) {
    await this.assertCitasActive(businessId);
    return this.getOrCreateSettings(businessId);
  }

  async updateSettings(businessId: string, dto: UpdateBookingSettingsDto) {
    await this.assertCitasActive(businessId);
    await this.getOrCreateSettings(businessId);

    return this.prisma.businessBookingSettings.update({
      where: { businessId },
      data: {
        ...(dto.minCancellationHours !== undefined && {
          minCancellationHours: dto.minCancellationHours,
        }),
        ...(dto.trackNoShows !== undefined && {
          trackNoShows: dto.trackNoShows,
        }),
        ...(dto.autoBlockAfterNoShows !== undefined && {
          autoBlockAfterNoShows: dto.autoBlockAfterNoShows,
        }),
        ...(dto.noShowThreshold !== undefined && {
          noShowThreshold: dto.noShowThreshold,
        }),
      },
    });
  }

  // =========================================================================
  // Especialistas
  // =========================================================================

  async getSpecialists(businessId: string) {
    await this.assertCitasActive(businessId);
    const specialists = await this.prisma.specialist.findMany({
      where: { businessId },
      include: {
        profession: true,
        _count: {
          select: { serviceSpecialists: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    return specialists.map((s) => ({
      ...s,
      specialty: s.profession?.name ?? s.specialty ?? '',
    }));
  }

  async createSpecialist(businessId: string, dto: CreateSpecialistDto) {
    await this.assertCitasActive(businessId);

    let professionId: string | null = null;
    let fallbackSpecialty = dto.specialty?.trim() || null;

    if (dto.professionId) {
      const profession = await this.prisma.profession.findFirst({
        where: { id: dto.professionId, businessId },
      });
      if (!profession) {
        throw new BadRequestException('La profesión especificada no existe en este negocio');
      }
      professionId = profession.id;
      if (!fallbackSpecialty) {
        fallbackSpecialty = profession.name;
      }
    }

    const created = await this.prisma.specialist.create({
      data: {
        businessId,
        name: dto.name.trim(),
        professionId,
        specialty: fallbackSpecialty,
        active: dto.active ?? true,
      },
      include: {
        profession: true,
        _count: {
          select: { serviceSpecialists: true },
        },
      },
    });

    return {
      ...created,
      specialty: created.profession?.name ?? created.specialty ?? '',
    };
  }

  async updateSpecialist(
    id: string,
    businessId: string,
    dto: UpdateSpecialistDto,
    isSuperAdmin: boolean = false,
  ) {
    const specialist = await this.prisma.specialist.findUnique({
      where: { id },
    });
    if (!specialist) {
      throw new NotFoundException('Especialista no encontrado');
    }
    if (!isSuperAdmin && specialist.businessId !== businessId) {
      throw new ForbiddenException(
        'No tienes permiso para modificar este especialista',
      );
    }
    await this.assertCitasActive(specialist.businessId);

    let professionId: string | null | undefined = undefined;
    let fallbackSpecialty: string | null | undefined =
      dto.specialty !== undefined
        ? dto.specialty
          ? dto.specialty.trim()
          : null
        : undefined;

    if (dto.professionId !== undefined) {
      if (dto.professionId === null || dto.professionId === '') {
        professionId = null;
      } else {
        const profession = await this.prisma.profession.findFirst({
          where: { id: dto.professionId, businessId: specialist.businessId },
        });
        if (!profession) {
          throw new BadRequestException('La profesión especificada no existe en este negocio');
        }
        professionId = profession.id;
        if (fallbackSpecialty === undefined) {
          fallbackSpecialty = profession.name;
        }
      }
    }

    const updated = await this.prisma.specialist.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(professionId !== undefined && { professionId }),
        ...(fallbackSpecialty !== undefined && { specialty: fallbackSpecialty }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
      include: {
        profession: true,
        _count: {
          select: { serviceSpecialists: true },
        },
      },
    });

    return {
      ...updated,
      specialty: updated.profession?.name ?? updated.specialty ?? '',
    };
  }

  async deleteSpecialist(
    id: string,
    businessId: string,
    isSuperAdmin: boolean = false,
  ) {
    const specialist = await this.prisma.specialist.findUnique({
      where: { id },
      include: {
        _count: {
          select: { serviceSpecialists: true },
        },
      },
    });
    if (!specialist) {
      throw new NotFoundException('Especialista no encontrado');
    }
    if (!isSuperAdmin && specialist.businessId !== businessId) {
      throw new ForbiddenException(
        'No tienes permiso para eliminar este especialista',
      );
    }
    await this.assertCitasActive(specialist.businessId);

    if (specialist._count.serviceSpecialists > 0) {
      const updated = await this.prisma.specialist.update({
        where: { id },
        data: { active: false },
      });
      return {
        message:
          'El especialista tiene servicios asociados, por lo que fue desactivado en lugar de eliminado.',
        deactivated: true,
        specialist: updated,
      };
    }

    await this.prisma.specialist.delete({
      where: { id },
    });
    return {
      message: 'Especialista eliminado exitosamente',
      deleted: true,
    };
  }

  // =========================================================================
  // Profesiones / Especialidades (Catálogo separado de Servicios)
  // =========================================================================

  async getProfessions(businessId: string) {
    await this.assertCitasActive(businessId);
    return this.prisma.profession.findMany({
      where: { businessId },
      include: {
        _count: {
          select: { specialists: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createProfession(businessId: string, dto: CreateProfessionDto) {
    await this.assertCitasActive(businessId);
    const trimmedName = dto.name.trim();

    const existing = await this.prisma.profession.findFirst({
      where: {
        businessId,
        name: {
          equals: trimmedName,
          mode: 'insensitive',
        },
      },
    });

    if (existing) {
      throw new ConflictException('Ya existe una profesión con este nombre en este negocio');
    }

    return this.prisma.profession.create({
      data: {
        businessId,
        name: trimmedName,
        active: dto.active ?? true,
      },
      include: {
        _count: {
          select: { specialists: true },
        },
      },
    });
  }

  async updateProfession(
    id: string,
    businessId: string,
    dto: UpdateProfessionDto,
  ) {
    await this.assertCitasActive(businessId);
    const profession = await this.prisma.profession.findFirst({
      where: { id, businessId },
    });

    if (!profession) {
      throw new NotFoundException('Profesión no encontrada');
    }

    if (dto.name !== undefined) {
      const trimmedName = dto.name.trim();
      const existing = await this.prisma.profession.findFirst({
        where: {
          businessId,
          id: { not: id },
          name: {
            equals: trimmedName,
            mode: 'insensitive',
          },
        },
      });

      if (existing) {
        throw new ConflictException('Ya existe otra profesión con este nombre en este negocio');
      }
    }

    return this.prisma.profession.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
      include: {
        _count: {
          select: { specialists: true },
        },
      },
    });
  }

  async deleteProfession(id: string, businessId: string) {
    await this.assertCitasActive(businessId);
    const profession = await this.prisma.profession.findFirst({
      where: { id, businessId },
      include: {
        _count: {
          select: { specialists: true },
        },
      },
    });

    if (!profession) {
      throw new NotFoundException('Profesión no encontrada');
    }

    if (profession._count.specialists > 0) {
      const updated = await this.prisma.profession.update({
        where: { id },
        data: { active: false },
      });
      return {
        message: 'La profesión tiene especialistas asociados, por lo que fue desactivada.',
        deactivated: true,
        profession: updated,
      };
    }

    await this.prisma.profession.delete({
      where: { id },
    });

    return {
      message: 'Profesión eliminada exitosamente',
      deleted: true,
    };
  }

  /**
   * Reasignación de especialista para una cita existente (ENCARGADO/CAJERO).
   */
  async reassignAppointmentSpecialist(
    appointmentId: string,
    businessId: string,
    newSpecialistId: string,
  ) {
    await this.assertCitasActive(businessId);

    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, businessId },
      include: {
        service: {
          include: {
            specialists: true,
          },
        },
      },
    });

    if (!appointment) {
      throw new NotFoundException('Cita no encontrada');
    }

    if (
      appointment.status === AppointmentStatus.CANCELLED ||
      appointment.status === AppointmentStatus.COMPLETED
    ) {
      throw new BadRequestException(
        'No se puede reasignar una cita cancelada o completada',
      );
    }

    // Validar que el especialista pertenezca al negocio
    const specialist = await this.prisma.specialist.findFirst({
      where: { id: newSpecialistId, businessId, active: true },
    });
    if (!specialist) {
      throw new BadRequestException(
        'El especialista no existe, está inactivo o no pertenece a este negocio',
      );
    }

    // Validar que el nuevo especialista esté asignado al servicio de esa cita
    const isAssigned = appointment.service.specialists.some(
      (s) => s.specialistId === newSpecialistId,
    );
    if (!isAssigned) {
      throw new BadRequestException(
        'El especialista no está asignado al servicio de esta cita',
      );
    }

    if (appointment.specialistId === newSpecialistId) {
      return this.prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: { service: true, specialist: true, customer: true },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const hasConflict = await this.hasConflictingAppointment(tx, {
        businessId,
        serviceId: appointment.serviceId,
        specialistId: newSpecialistId,
        scheduledAt: appointment.scheduledAt,
        durationMinutes: appointment.durationMinutes,
        excludeAppointmentId: appointment.id,
      });

      if (hasConflict) {
        throw new ConflictException(
          'El especialista no se encuentra disponible en el horario de esta cita',
        );
      }

      return tx.appointment.update({
        where: { id: appointmentId },
        data: { specialistId: newSpecialistId },
        include: { service: true, specialist: true, customer: true },
      });
    });
  }
}
