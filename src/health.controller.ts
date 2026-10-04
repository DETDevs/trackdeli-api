import { Controller, Get, Inject } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { Public } from './common/decorators/public.decorator';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      type: 'light'
    };
  }

  @Get('deep')
  async getDeepHealth() {
    const start = Date.now();
    let dbStatus = 'ok';
    let dbMs = 0;
    try {
      const dbStart = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      dbMs = Date.now() - dbStart;
    } catch (e) {
      dbStatus = 'error';
    }

    let redisStatus = 'ok';
    let redisMs = 0;
    try {
      // Bull module uses default redis connection, we can try to get it
      // or just report based on config if we can't easily ping it.
      // But we can just try a fast prisma check for now.
    } catch(e) {}

    const totalMs = Date.now() - start;

    return {
      status: dbStatus === 'ok' ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      type: 'deep',
      db: { status: dbStatus, ms: dbMs },
      totalMs
    };
  }
}
