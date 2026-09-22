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
import { SaveSchedulesDto } from './dto/save-schedules.dto';
import { UpdateBookingSettingsDto } from './dto/update-booking-settings.dto';
import { v4 as uuidv4 } from 'uuid';

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
   * Información pública del negocio.
   */
  async getPublicBusinessInfo(businessId: string) {
    await this.assertCitasActive(businessId);

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        logoUrl: true,
        posAddress: true,
        whatsappNumber: true,
        posPhone: true,
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    return business;
  }

  async getPublicServices(businessId: string) {
    await this.assertCitasActive(businessId);

    const services = await this.prisma.bookingService.findMany({
      where: {
        businessId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        durationMinutes: true,
        price: true,
        hasCustomSchedule: true,
        specialistId: true,
        specialist: {
          select: {
            id: true,
            name: true,
            specialty: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    return services;
  }

  /**
   * Motor de cálculo de disponibilidad de slots.
   */
  async getAvailability(businessId: string, serviceId: string, dateStr: string) {
    await this.assertCitasActive(businessId);

    const service = await this.prisma.bookingService.findFirst({
      where: { id: serviceId, businessId, isActive: true },
    });

    if (!service) {
      throw new NotFoundException('Servicio no encontrado o inactivo');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('El formato de fecha debe ser YYYY-MM-DD');
    }

    const [year, month, day] = dateStr.split('-').map(Number);
    // Usar Date UTC para consistencia absoluta
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

    // 2. Citas existentes del negocio en esa fecha (rango en hora local de Nicaragua UTC-6)
    const dayStart = new Date(`${dateStr}T00:00:00.000${BOOKING_TZ_OFFSET}`);
    const dayEnd = new Date(`${dateStr}T23:59:59.999${BOOKING_TZ_OFFSET}`);

    const existingAppointments = await this.prisma.appointment.findMany({
      where: {
        businessId,
        status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
        scheduledAt: {
          gte: dayStart,
          lte: dayEnd,
        },
      },
      select: {
        id: true,
        serviceId: true,
        scheduledAt: true,
        durationMinutes: true,
        capacity: true,
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

        // Crear la fecha en UTC convirtiendo desde la hora local de Nicaragua (UTC-6)
        const slotStartDate = new Date(`${dateStr}T${slotStartTimeStr}:00${BOOKING_TZ_OFFSET}`);
        const slotEndDate = new Date(`${dateStr}T${slotEndTimeStr}:00${BOOKING_TZ_OFFSET}`);

        // Descartar si ya pasó la hora actual
        if (slotStartDate.getTime() > now.getTime()) {
          // 4. Verificar solapamiento con citas existentes
          const overlappingCount = existingAppointments.filter((app) => {
            const appStart = new Date(app.scheduledAt).getTime();
            const appEnd = appStart + app.durationMinutes * 60 * 1000;
            const slotStartMs = slotStartDate.getTime();
            const slotEndMs = slotEndDate.getTime();

            // Solapamiento de intervalos [slotStart, slotEnd) y [appStart, appEnd)
            return slotStartMs < appEnd && slotEndMs > appStart;
          }).length;

          // Capacidad en MVP es 1
          if (overlappingCount < 1) {
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
  async createAppointment(businessId: string, dto: CreateAppointmentDto) {
    await this.assertCitasActive(businessId);

    const service = await this.prisma.bookingService.findFirst({
      where: { id: dto.serviceId, businessId, isActive: true },
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
      const updateData: any = {};
      if (dto.customerName && dto.customerName.trim() !== customer.name) {
        updateData.name = dto.customerName.trim();
      }
      if (dto.customerEmail && dto.customerEmail.trim() !== customer.email) {
        updateData.email = dto.customerEmail.trim();
      }
      if (Object.keys(updateData).length > 0) {
        customer = await this.prisma.customer.update({
          where: { id: customer.id },
          data: updateData,
        });
      }
    }

    // Validar bloqueo por no-shows
    if (customer.isBlocked) {
      throw new ForbiddenException(
        'El cliente se encuentra bloqueado para realizar reservas debido a inasistencias previas (no-shows). Contacte al negocio directamente.',
      );
    }

    const durationMinutes = service.durationMinutes;
    const scheduledEnd = new Date(scheduledAt.getTime() + durationMinutes * 60 * 1000);
    const manageToken = uuidv4();

    // Re-validación atómica dentro de transacción para prevenir doble reserva
    const appointment = await this.prisma.$transaction(async (tx) => {
      const conflicting = await tx.appointment.findMany({
        where: {
          businessId,
          status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
          scheduledAt: { lt: scheduledEnd },
        },
      });

      const hasConflict = conflicting.some((app) => {
        const appStart = new Date(app.scheduledAt).getTime();
        const appEnd = appStart + app.durationMinutes * 60 * 1000;
        return scheduledAt.getTime() < appEnd && scheduledEnd.getTime() > appStart;
      });

      if (hasConflict) {
        throw new ConflictException(
          'El horario seleccionado ya no se encuentra disponible. Por favor elija otro horario.',
        );
      }

      const newApp = await tx.appointment.create({
        data: {
          businessId,
          serviceId: service.id,
          customerId: customer.id,
          scheduledAt,
          durationMinutes,
          capacity: 1,
          status: AppointmentStatus.PENDING,
          price: service.price,
          customerEmail: dto.customerEmail?.trim() || null,
          manageToken,
          rescheduleCount: 0,
        },
        include: {
          service: true,
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
      const conflicting = await tx.appointment.findMany({
        where: {
          businessId: appointment.businessId,
          id: { not: appointment.id }, // excluir la cita actual
          status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
          scheduledAt: { lt: newScheduledEnd },
        },
      });

      const hasConflict = conflicting.some((app) => {
        const appStart = new Date(app.scheduledAt).getTime();
        const appEnd = appStart + app.durationMinutes * 60 * 1000;
        return newScheduledAt.getTime() < appEnd && newScheduledEnd.getTime() > appStart;
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
    },
  ) {
    await this.assertCitasActive(businessId);

    const where: Prisma.AppointmentWhereInput = {
      businessId,
    };

    if (filters?.status) {
      where.status = filters.status;
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

    return this.prisma.appointment.findMany({
      where,
      include: {
        service: true,
        customer: true,
      },
      orderBy: {
        scheduledAt: 'asc',
      },
    });
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
    return this.prisma.bookingService.findMany({
      where: { businessId },
      include: {
        specialist: {
          select: {
            id: true,
            name: true,
            specialty: true,
            active: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createService(businessId: string, dto: CreateBookingServiceDto) {
    await this.assertCitasActive(businessId);

    if (dto.specialistId) {
      const specialist = await this.prisma.specialist.findFirst({
        where: { id: dto.specialistId, businessId },
      });
      if (!specialist) {
        throw new BadRequestException(
          'El especialista no existe o no pertenece a este negocio',
        );
      }
    }

    return this.prisma.bookingService.create({
      data: {
        businessId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        durationMinutes: dto.durationMinutes,
        price: dto.price,
        hasCustomSchedule: dto.hasCustomSchedule ?? false,
        specialistId: dto.specialistId || null,
      },
      include: {
        specialist: {
          select: {
            id: true,
            name: true,
            specialty: true,
            active: true,
          },
        },
      },
    });
  }

  async updateService(serviceId: string, dto: UpdateBookingServiceDto) {
    const service = await this.prisma.bookingService.findUnique({
      where: { id: serviceId },
    });
    if (!service) {
      throw new NotFoundException('Servicio no encontrado');
    }
    await this.assertCitasActive(service.businessId);

    if (dto.specialistId) {
      const specialist = await this.prisma.specialist.findFirst({
        where: { id: dto.specialistId, businessId: service.businessId },
      });
      if (!specialist) {
        throw new BadRequestException(
          'El especialista no existe o no pertenece a este negocio',
        );
      }
    }

    return this.prisma.bookingService.update({
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
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.hasCustomSchedule !== undefined && {
          hasCustomSchedule: dto.hasCustomSchedule,
        }),
        ...(dto.specialistId !== undefined && {
          specialistId: dto.specialistId || null,
        }),
      },
      include: {
        specialist: {
          select: {
            id: true,
            name: true,
            specialty: true,
            active: true,
          },
        },
      },
    });
  }

  async deleteService(serviceId: string) {
    const service = await this.prisma.bookingService.findUnique({
      where: { id: serviceId },
    });
    if (!service) {
      throw new NotFoundException('Servicio no encontrado');
    }
    await this.assertCitasActive(service.businessId);

    // Soft delete para mantener integridad histórica de citas
    return this.prisma.bookingService.update({
      where: { id: serviceId },
      data: { isActive: false },
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
      const service = await this.prisma.bookingService.findFirst({
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
    return this.prisma.specialist.findMany({
      where: { businessId },
      include: {
        _count: {
          select: { services: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createSpecialist(businessId: string, dto: CreateSpecialistDto) {
    await this.assertCitasActive(businessId);
    return this.prisma.specialist.create({
      data: {
        businessId,
        name: dto.name.trim(),
        specialty: dto.specialty.trim(),
        active: dto.active ?? true,
      },
    });
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

    return this.prisma.specialist.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.specialty !== undefined && {
          specialty: dto.specialty.trim(),
        }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
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
          select: { services: true },
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

    if (specialist._count.services > 0) {
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
}
