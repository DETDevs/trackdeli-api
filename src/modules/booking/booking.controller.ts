import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { Public } from '../../common/decorators/public.decorator';
import { SkipMembershipCheck } from '../../common/decorators/skip-membership.decorator';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { CreateAppointmentHoldDto } from './dto/create-appointment-hold.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import { Throttle } from '@nestjs/throttler';

@Public()
@SkipMembershipCheck()
@Controller()
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  /**
   * Información pública del negocio para la página de reservas.
   * GET /booking/:businessId/info
   * GET /businesses/:businessId/booking/info
   */
  @Get([
    'booking/:businessId/info',
    'businesses/:businessId/booking/info',
  ])
  async getBusinessInfo(@Param('businessId') businessId: string) {
    return this.bookingService.getPublicBusinessInfo(businessId);
  }

  /**
   * Catálogo público de servicios del negocio.
   * GET /booking/:businessId/services
   * GET /businesses/:businessId/booking/services
   */
  @Get([
    'booking/:businessId/services',
    'businesses/:businessId/booking/services',
  ])
  async getServices(@Param('businessId') businessId: string) {
    return this.bookingService.getPublicServices(businessId);
  }

  /**
   * Cálculo de slots disponibles para un servicio y fecha.
   * Excluye citas confirmadas y reservas temporales (holds) activas.
   * GET /booking/:businessId/services/:serviceId/availability?date=YYYY-MM-DD
   * GET /businesses/:businessId/booking/services/:serviceId/availability?date=YYYY-MM-DD
   */
  @Get([
    'booking/:businessId/services/:serviceId/availability',
    'businesses/:businessId/booking/services/:serviceId/availability',
    'businesses/:businessId/booking/availability',
  ])
  async getAvailability(
    @Param('businessId') businessId: string,
    @Param('serviceId') serviceId: string,
    @Query('date') date: string,
    @Query('specialistId') specialistId?: string,
  ) {
    return this.bookingService.getAvailability(businessId, serviceId, date, specialistId);
  }

  /**
   * 80a: Crear reserva temporal (hold) de horario para evitar doble reserva.
   * POST /booking/:businessId/holds
   * POST /businesses/:businessId/booking/holds
   */
  @Post([
    'booking/:businessId/holds',
    'businesses/:businessId/booking/holds',
  ])
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async createHold(
    @Param('businessId') businessId: string,
    @Body() dto: CreateAppointmentHoldDto,
  ) {
    return this.bookingService.createHold(businessId, dto);
  }

  /**
   * 80a: Liberar reserva temporal explícitamente cuando el usuario cancela o da atrás.
   * DELETE /booking/:businessId/holds/:holdId
   * DELETE /businesses/:businessId/booking/holds/:holdId
   * DELETE /booking/holds/:holdId
   */
  @Delete([
    'booking/:businessId/holds/:holdId',
    'businesses/:businessId/booking/holds/:holdId',
    'booking/holds/:holdId',
  ])
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async releaseHold(
    @Param('holdId') holdId: string,
    @Body('holderToken') bodyToken?: string,
    @Headers('x-holder-token') headerToken?: string,
    @Headers('holder-token') headerToken2?: string,
    @Query('holderToken') queryToken?: string,
  ) {
    const token = bodyToken || headerToken || headerToken2 || queryToken;
    return this.bookingService.releaseHold(holdId, token);
  }

  /**
   * Crear nueva reserva pública. Requiere holdId + holderToken válidos y no expirados.
   * POST /booking/:businessId/appointments
   * POST /businesses/:businessId/booking/appointments
   */
  @Post([
    'booking/:businessId/appointments',
    'businesses/:businessId/booking/appointments',
  ])
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async createAppointment(
    @Param('businessId') businessId: string,
    @Body() dto: CreateAppointmentDto,
  ) {
    return this.bookingService.createAppointment(businessId, dto);
  }

  /**
   * Ver detalle de la cita por token único (autogestión).
   * GET /booking/manage/:token
   */
  @Get('booking/manage/:token')
  async getAppointmentByToken(@Param('token') token: string) {
    return this.bookingService.getAppointmentByToken(token);
  }

  /**
   * Cancelar cita por el cliente (bloquea si está dentro de minCancellationHours).
   * POST /booking/manage/:token/cancel
   */
  @Post('booking/manage/:token/cancel')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async cancelAppointmentByToken(@Param('token') token: string) {
    return this.bookingService.cancelAppointmentByToken(token);
  }

  /**
   * Reagendar cita por el cliente (máx 1 vez, bloquea si está dentro de minCancellationHours).
   * POST /booking/manage/:token/reschedule
   */
  @Post('booking/manage/:token/reschedule')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async rescheduleAppointmentByToken(
    @Param('token') token: string,
    @Body() dto: RescheduleAppointmentDto,
  ) {
    return this.bookingService.rescheduleAppointmentByToken(
      token,
      dto.newScheduledAt,
    );
  }
}
