import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { SkipClientVersionCheck } from './decorators/skip-client-version-check.decorator';
import { ClientVersionService } from './client-version.service';
import { GetClientVersionQueryDto } from './dto/get-client-version.dto';
import { DEFAULT_PLATFORM } from './client-version.constants';

@Controller('client-version')
export class ClientVersionController {
  constructor(private readonly clientVersionService: ClientVersionService) {}

  @Public()
  @SkipClientVersionCheck()
  @Get()
  async getClientVersion(@Query() query: GetClientVersionQueryDto) {
    const platform = query?.platform || DEFAULT_PLATFORM;
    return this.clientVersionService.getSettingDetails(platform);
  }
}
