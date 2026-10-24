import { Module } from "@nestjs/common";
import { PrismaModule } from "../../../prisma/prisma.module";
import { TrackingModule } from "../../tracking/tracking.module";
import { BatchesModule } from "../batches/batches.module";
import { OfflineController } from "./offline.controller";
import { OfflineService } from "./offline.service";

@Module({
  imports: [PrismaModule, TrackingModule, BatchesModule],
  controllers: [OfflineController],
  providers: [OfflineService],
  exports: [OfflineService],
})
export class OfflineModule {}

