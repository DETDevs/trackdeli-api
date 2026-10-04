import { Module } from '@nestjs/common';
import { PosPermissionsService } from './permissions.service';
import { PosPermissionsGuard } from './permissions.guard';
import { PoliciesModule } from '../policies/policies.module';

@Module({
  imports: [PoliciesModule],
  providers: [PosPermissionsService, PosPermissionsGuard],
  exports: [PosPermissionsService, PosPermissionsGuard],
})
export class PosPermissionsModule {}
