import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';
import { AuthModule } from '../../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { WaitersController } from './waiters.controller';
import { WaitersService } from './waiters.service';

@Module({
  imports: [
    PrismaModule,
    BusinessProductsModule,
    AuthModule,
    ConfigModule,
  ],
  controllers: [WaitersController],
  providers: [WaitersService],
  exports: [WaitersService],
})
export class WaitersModule {}
