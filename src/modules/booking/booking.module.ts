import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BusinessProductsModule } from '../business-products/business-products.module';
import { BookingController } from './booking.controller';
import { BookingPanelController } from './booking-panel.controller';
import { SpecialistsController } from './specialists.controller';
import { BookingService } from './booking.service';
import { BookingEmailService } from './booking-email.service';

@Module({
  imports: [PrismaModule, BusinessProductsModule],
  controllers: [
    BookingController,
    BookingPanelController,
    SpecialistsController,
  ],
  providers: [BookingService, BookingEmailService],
  exports: [BookingService, BookingEmailService],
})
export class BookingModule {}
