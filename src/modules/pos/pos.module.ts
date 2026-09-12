import { Module } from '@nestjs/common';
import { CategoriesModule } from './categories/categories.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { ProductsModule } from './products/products.module';
import { SalesModule } from './sales/sales.module';
import { CashRegisterModule } from './cash-register/cash-register.module';
import { ReportsModule } from './reports/reports.module';
import { SettingsModule } from './settings/settings.module';
import { TablesModule } from './tables/tables.module';
import { OfflineModule } from './offline/offline.module';

@Module({
  imports: [
    CategoriesModule,
    SuppliersModule,
    ProductsModule,
    SalesModule,
    CashRegisterModule,
    ReportsModule,
    SettingsModule,
    TablesModule,
    OfflineModule,
  ],
})
export class PosModule {}
