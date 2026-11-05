import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CommercialService } from './commercial.service';
import { SuperAdminGuard } from '../../../common/guards/superadmin.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { UpsertCommercialAgreementDto } from './dto/upsert-commercial-agreement.dto';
import { CreateCommercialPaymentDto } from './dto/create-commercial-payment.dto';
import { VoidCommercialPaymentDto } from './dto/void-commercial-payment.dto';
import { CreateCommercialEquipmentDto } from './dto/create-commercial-equipment.dto';
import { UpdateCommercialEquipmentDto } from './dto/update-commercial-equipment.dto';

@Controller('superadmin')
@UseGuards(SuperAdminGuard)
@Roles(UserRole.SUPERADMIN)
export class CommercialController {
  constructor(private readonly commercialService: CommercialService) {}

  @Get('businesses/:id/commercial')
  async getCommercialAgreement(@Param('id') businessId: string) {
    return this.commercialService.getCommercialAgreement(businessId);
  }

  @Put('businesses/:id/commercial')
  async upsertCommercialAgreement(
    @Param('id') businessId: string,
    @Body() dto: UpsertCommercialAgreementDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.upsertCommercialAgreement(businessId, dto, user);
  }

  @Post('businesses/:id/commercial')
  async postCommercialAgreement(
    @Param('id') businessId: string,
    @Body() dto: UpsertCommercialAgreementDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.upsertCommercialAgreement(businessId, dto, user);
  }

  @Post('businesses/:id/commercial/agreement')
  async postCommercialAgreementAlias(
    @Param('id') businessId: string,
    @Body() dto: UpsertCommercialAgreementDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.upsertCommercialAgreement(businessId, dto, user);
  }

  @Post('commercial/:agreementId/payments')
  async recordPayment(
    @Param('agreementId') agreementId: string,
    @Body() dto: CreateCommercialPaymentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.recordPayment(agreementId, dto, user);
  }

  @Post('businesses/:businessId/commercial/payments')
  async recordPaymentByBusiness(
    @Param('businessId') businessId: string,
    @Body() dto: CreateCommercialPaymentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.recordPayment(businessId, dto, user);
  }

  @Post('commercial/payments/:paymentId/proof')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
      fileFilter: (req, file, cb) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|webp|pdf)$/)) {
          return cb(
            new BadRequestException('Solo se permiten imágenes (JPG, PNG, WebP) o PDF'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async uploadPaymentProof(
    @Param('paymentId') paymentId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.commercialService.uploadPaymentProof(paymentId, file);
  }

  @Post('commercial/payments/:paymentId/void')
  async voidPayment(
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidCommercialPaymentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.voidPayment(paymentId, dto, user);
  }

  @Post('businesses/:businessId/commercial/payments/:paymentId/void')
  async voidPaymentByBusiness(
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidCommercialPaymentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.voidPayment(paymentId, dto, user);
  }

  @Post('commercial/:agreementId/equipment')
  async createEquipment(
    @Param('agreementId') agreementId: string,
    @Body() dto: CreateCommercialEquipmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.createEquipment(agreementId, dto, user);
  }

  @Post('businesses/:businessId/commercial/equipment')
  async createEquipmentByBusiness(
    @Param('businessId') businessId: string,
    @Body() dto: CreateCommercialEquipmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.createEquipment(businessId, dto, user);
  }

  @Patch('commercial/equipment/:id')
  async updateEquipment(
    @Param('id') id: string,
    @Body() dto: UpdateCommercialEquipmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.updateEquipment(id, dto, user);
  }

  @Patch('businesses/:businessId/commercial/equipment/:id')
  async updateEquipmentByBusiness(
    @Param('id') id: string,
    @Body() dto: UpdateCommercialEquipmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.commercialService.updateEquipment(id, dto, user);
  }
}
