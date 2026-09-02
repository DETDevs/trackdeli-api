import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [PrismaModule, TrackingModule, ConfigModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
