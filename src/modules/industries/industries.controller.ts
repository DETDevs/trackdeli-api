import { Controller, Get, UseGuards } from '@nestjs/common';
import { IndustriesService } from './industries.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SkipMembership } from '../../common/decorators/skip-membership.decorator';

@SkipMembership()
@UseGuards(JwtAuthGuard)
@Controller('industries')
export class IndustriesController {
  constructor(private readonly service: IndustriesService) {}

  @Get()
  findAllActive() {
    return this.service.findAllActive();
  }
}
