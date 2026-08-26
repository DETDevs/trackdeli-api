import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();

    // @ts-ignore
    this.$on('query', (e: any) => {
      if (e.duration > 500) {
        this.logger.warn(`Query lenta (${e.duration}ms): ${e.query}`);
      }
    });

    // @ts-ignore
    this.$on('error', (e: any) => {
      this.logger.error(`Prisma Error: ${e.message}`);
    });
  }
}
