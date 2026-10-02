import {
  Controller, Post, Get, UseGuards, UseInterceptors, UploadedFile,
  Body, Query, Res, BadRequestException, Param, ParseBoolPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { ProductsImportService } from './products-import.service';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Controller('pos/products')
export class ProductsImportController {
  constructor(private readonly importService: ProductsImportService) {}

  @Get('export')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async exportProducts(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid: string,
    @Res() res: Response
  ) {
    const bId = resolveBusinessId(user, qBid);
    const wb = await this.importService.exportProducts(bId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=productos.xlsx');
    await wb.xlsx.write(res);
    res.end();
  }

  @Get('import-template')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async getTemplate(
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid: string,
    @Res() res: Response
  ) {
    const bId = resolveBusinessId(user, qBid);
    const wb = await this.importService.generateTemplate(bId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=plantilla_productos.xlsx');
    await wb.xlsx.write(res);
    res.end();
  }

  @Post('import/analyze')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async analyze(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid: string,
  ) {
    if (!file) throw new BadRequestException('Archivo no proveído');
    const bId = resolveBusinessId(user, qBid);
    return this.importService.analyzeFile(bId, file.buffer, file.mimetype, file.originalname);
  }

  @Post('import')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async doImport(
    @UploadedFile() file: Express.Multer.File,
    @Body('mapping') mappingStr: string,
    @Body('sheet') sheet: string,
    @Body('headerRow') headerRowStr: string,
    @Query('dryRun', ParseBoolPipe) dryRun: boolean,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid: string,
  ) {
    if (!file) throw new BadRequestException('Archivo no proveído');
    const bId = resolveBusinessId(user, qBid);
    let mapping;
    try {
      mapping = JSON.parse(mappingStr);
    } catch {
      throw new BadRequestException('El mapping debe ser un JSON válido');
    }
    const headerRow = parseInt(headerRowStr, 10);
    if (isNaN(headerRow)) throw new BadRequestException('Fila de encabezado inválida');

    return this.importService.importFile(
      bId, user.sub, file.buffer, file.mimetype, file.originalname, mapping, sheet, headerRow, dryRun
    );
  }
}

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('superadmin')
export class SuperAdminProductsImportController {
  constructor(private readonly importService: ProductsImportService) {}

  @Get('industries/:id/import-template')
  @Roles(UserRole.SUPERADMIN)
  async getIndustryTemplate(
    @Param('id') id: string,
    @Res() res: Response
  ) {
    const wb = await this.importService.generateTemplate(null, id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=plantilla_industria.xlsx');
    await wb.xlsx.write(res);
    res.end();
  }

  @Get('businesses/:businessId/products/export')
  @Roles(UserRole.SUPERADMIN)
  async exportBusinessProducts(
    @Param('businessId') businessId: string,
    @Res() res: Response
  ) {
    const wb = await this.importService.exportProducts(businessId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=productos.xlsx');
    await wb.xlsx.write(res);
    res.end();
  }

  @Get('businesses/:businessId/products/import-template')
  @Roles(UserRole.SUPERADMIN)
  async getBusinessTemplate(
    @Param('businessId') businessId: string,
    @Res() res: Response
  ) {
    const wb = await this.importService.generateTemplate(businessId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=plantilla_productos.xlsx');
    await wb.xlsx.write(res);
    res.end();
  }

  @Post('businesses/:businessId/products/import/analyze')
  @Roles(UserRole.SUPERADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async analyzeForBusiness(
    @Param('businessId') businessId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo no proveído');
    return this.importService.analyzeFile(businessId, file.buffer, file.mimetype, file.originalname);
  }

  @Post('businesses/:businessId/products/import')
  @Roles(UserRole.SUPERADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async doImportForBusiness(
    @Param('businessId') businessId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('mapping') mappingStr: string,
    @Body('sheet') sheet: string,
    @Body('headerRow') headerRowStr: string,
    @Query('dryRun', ParseBoolPipe) dryRun: boolean,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!file) throw new BadRequestException('Archivo no proveído');
    let mapping;
    try {
      mapping = JSON.parse(mappingStr);
    } catch {
      throw new BadRequestException('El mapping debe ser un JSON válido');
    }
    const headerRow = parseInt(headerRowStr, 10);
    if (isNaN(headerRow)) throw new BadRequestException('Fila de encabezado inválida');

    return this.importService.importFile(
      businessId, user.sub, file.buffer, file.mimetype, file.originalname, mapping, sheet, headerRow, dryRun
    );
  }
}
