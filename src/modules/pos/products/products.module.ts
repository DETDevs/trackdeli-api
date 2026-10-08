import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { ProductsImportService } from './products-import.service';
import { ProductsImportController, SuperAdminProductsImportController } from './products-import.controller';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ProductsImportController, SuperAdminProductsImportController, ProductsController],
  providers: [ProductsService, ProductsImportService],
  exports: [ProductsService, ProductsImportService],
})
export class ProductsModule {}
