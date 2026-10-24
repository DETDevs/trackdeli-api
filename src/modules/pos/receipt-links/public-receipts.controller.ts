import {
  Controller,
  Get,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../../common/decorators/public.decorator';
import { SkipMembershipCheck } from '../../../common/decorators/skip-membership.decorator';
import { SkipClientVersionCheck } from '../../client-version/decorators/skip-client-version-check.decorator';
import { ReceiptLinksService } from './receipt-links.service';

@Public()
@SkipClientVersionCheck()
@SkipMembershipCheck()
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('public/receipts')
export class PublicReceiptsController {
  constructor(private readonly service: ReceiptLinksService) {}

  /**
   * Endpoint público que devuelve los datos del comprobante en formato JSON para la web tracking.
   * Rate limit: 30 req/min por IP.
   */
  @Get(':token')
  async getPublicReceipt(@Param('token') token: string, @Req() req: any) {
    return this.service.getPublicReceiptData(token, req);
  }

  /**
   * Transmite el archivo PDF del comprobante desde R2 a través de la API (stream).
   */
  @Get(':token/pdf')
  async downloadReceiptPdf(@Param('token') token: string, @Res() res: any) {
    return this.service.streamReceiptPdf(token, res);
  }
}
