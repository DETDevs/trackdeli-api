import {
  Controller,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PosGuard } from '../../../common/guards/pos.guard';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { resolveBusinessId } from '../pos.utils';
import { ReceiptLinksService } from './receipt-links.service';

@SkipMembershipCheck()
@UseGuards(JwtAuthGuard, PosGuard)
@Roles(UserRole.ENCARGADO, UserRole.CAJERO, UserRole.SUPERADMIN)
@Controller('pos/sales')
export class ReceiptLinksController {
  constructor(private readonly service: ReceiptLinksService) {}

  /**
   * Sube el comprobante de venta en PDF generado por el desktop a R2 y devuelve enlace público /r/:token
   */
  @Post(':id/receipt-pdf')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 500 * 1024 } }))
  async uploadReceiptPdf(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
    @Req() req: any,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.uploadReceiptPdf(id, businessId, user.sub, file, req);
  }

  /**
   * Revoca el comprobante digital de una venta (solo ENCARGADO / SUPERADMIN) y borra el archivo de R2
   */
  @Post(':id/receipt-link/revoke')
  @Roles(UserRole.ENCARGADO, UserRole.SUPERADMIN)
  async revokeReceiptLink(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('businessId') qBid?: string,
  ) {
    const businessId = resolveBusinessId(user, qBid);
    return this.service.revokeReceiptLink(id, businessId, user.role);
  }
}
