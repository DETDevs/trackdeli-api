import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { BusinessProductsModule } from '../../business-products/business-products.module';
import { ProductFieldsService } from './product-fields.service';
import { ProductFieldsController } from './product-fields.controller';
import { SuperAdminProductFieldsController } from './superadmin-product-fields.controller';

@Module({
  imports: [PrismaModule, BusinessProductsModule],
  controllers: [ProductFieldsController, SuperAdminProductFieldsController],
  providers: [ProductFieldsService],
  exports: [ProductFieldsService],
})
export class ProductFieldsModule {}
