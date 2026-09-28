import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BusinessProductsModule } from '../business-products/business-products.module';
import { BookingController } from './booking.controller';
import { BookingPanelController } from './booking-panel.controller';
import { SpecialistsController } from './specialists.controller';
import { ProfessionsController } from './professions.controller';
import { BookingService } from './booking.service';
import { BookingEmailService } from './booking-email.service';
import { SalesModule } from '../pos/sales/sales.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, BusinessProductsModule, SalesModule, NotificationsModule],
  controllers: [
    BookingController,
    BookingPanelController,
    SpecialistsController,
    ProfessionsController,
  ],
  providers: [BookingService, BookingEmailService],
  exports: [BookingService, BookingEmailService],
})
export class BookingModule {}
