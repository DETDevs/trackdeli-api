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
import { CreditModule } from './credit/credit.module';
import { WaitersModule } from './waiters/waiters.module';
import { ProductFieldsModule } from './product-fields/product-fields.module';
import { PosUsersController } from './users/pos-users.controller';
import { PosUsersService } from './users/pos-users.service';

// Foundation Modules
import { PosPermissionsModule } from './permissions/permissions.module';
import { AuditModule } from './audit/audit.module';
import { PoliciesModule } from './policies/policies.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { IdempotencyModule } from './idempotency/idempotency.module';

@Module({
  imports: [
    CategoriesModule,
    SuppliersModule,
    ProductsModule,
    ProductFieldsModule,
    SalesModule,
    CashRegisterModule,
    ReportsModule,
    SettingsModule,
    TablesModule,
    OfflineModule,
    CreditModule,
    WaitersModule,
    PosPermissionsModule,
    AuditModule,
    PoliciesModule,
    ApprovalsModule,
    IdempotencyModule,
  ],
  controllers: [PosUsersController],
  providers: [PosUsersService],
  exports: [ProductFieldsModule, PosPermissionsModule, AuditModule, PoliciesModule, ApprovalsModule, IdempotencyModule],
})
export class PosModule {}
