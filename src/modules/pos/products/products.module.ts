import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductPresentationsController } from './product-presentations.controller';
import { ProductsService } from './products.service';
import { ProductPresentationsService } from './product-presentations.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { ProductsImportService } from './products-import.service';
import { ProductsImportController, SuperAdminProductsImportController } from './products-import.controller';
import { BatchesModule } from '../batches/batches.module';
import { UnitsModule } from '../units/units.module';
import { UploadModule } from '../../upload/upload.module';

@Module({
  imports: [PrismaModule, AuditModule, BatchesModule, UnitsModule, UploadModule],
  controllers: [
    ProductsImportController,
    SuperAdminProductsImportController,
    ProductPresentationsController,
    ProductsController,
  ],
  providers: [ProductsService, ProductPresentationsService, ProductsImportService],
  exports: [ProductsService, ProductPresentationsService, ProductsImportService],
})
export class ProductsModule {}
