import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BusinessProductsController } from './business-products.controller';
import { BusinessProductsService } from './business-products.service';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [BusinessProductsController],
  providers: [BusinessProductsService],
  exports: [BusinessProductsService],
})
export class BusinessProductsModule {}
