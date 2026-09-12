import { Module } from "@nestjs/common";
import { PrismaModule } from "../../../prisma/prisma.module";
import { TrackingModule } from "../../tracking/tracking.module";
import { OfflineController } from "./offline.controller";
import { OfflineService } from "./offline.service";

@Module({
  imports: [PrismaModule, TrackingModule],
  controllers: [OfflineController],
  providers: [OfflineService],
  exports: [OfflineService],
})
export class OfflineModule {}

