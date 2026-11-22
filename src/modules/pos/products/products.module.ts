import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductPresentationsController } from './product-presentations.controller';
import { ProductVariantsController } from './product-variants.controller';
import { ProductsService } from './products.service';
import { ProductPresentationsService } from './product-presentations.service';
import { ProductVariantsService } from './product-variants.service';
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
    ProductVariantsController,
    ProductsController,
  ],
  providers: [
    ProductsService,
    ProductPresentationsService,
    ProductVariantsService,
    ProductsImportService,
  ],
  exports: [
    ProductsService,
    ProductPresentationsService,
    ProductVariantsService,
    ProductsImportService,
  ],
})
export class ProductsModule {}
