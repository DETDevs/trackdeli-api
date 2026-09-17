import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { Public } from '../../common/decorators/public.decorator';
import { SkipMembershipCheck } from '../../common/decorators/skip-membership.decorator';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

@Public()
@SkipMembershipCheck()
@Controller('booking')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  /**
   * Catálogo público de servicios del negocio.
   * GET /booking/:businessId/services
   */
  @Get(':businessId/services')
  async getServices(@Param('businessId') businessId: string) {
    return this.bookingService.getPublicServices(businessId);
  }

  /**
   * Cálculo de slots disponibles para un servicio y fecha.
   * GET /booking/:businessId/services/:serviceId/availability?date=YYYY-MM-DD
   */
  @Get(':businessId/services/:serviceId/availability')
  async getAvailability(
    @Param('businessId') businessId: string,
    @Param('serviceId') serviceId: string,
    @Query('date') date: string,
  ) {
    return this.bookingService.getAvailability(businessId, serviceId, date);
  }

  /**
   * Crear nueva reserva pública.
   * POST /booking/:businessId/appointments
   */
  @Post(':businessId/appointments')
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
  @Get('manage/:token')
  async getAppointmentByToken(@Param('token') token: string) {
    return this.bookingService.getAppointmentByToken(token);
  }

  /**
   * Cancelar cita por el cliente (bloquea si está dentro de minCancellationHours).
   * POST /booking/manage/:token/cancel
   */
  @Post('manage/:token/cancel')
  async cancelAppointmentByToken(@Param('token') token: string) {
    return this.bookingService.cancelAppointmentByToken(token);
  }

  /**
   * Reagendar cita por el cliente (máx 1 vez, bloquea si está dentro de minCancellationHours).
   * POST /booking/manage/:token/reschedule
   */
  @Post('manage/:token/reschedule')
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
