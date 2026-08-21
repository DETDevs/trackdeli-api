import { Controller, Get } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get('health')
  healthCheck() {
    return { status: 'ok', module: 'users' };
  }
}

