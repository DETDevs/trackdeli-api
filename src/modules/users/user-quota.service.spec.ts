import { Test, TestingModule } from '@nestjs/testing';
import { UserQuotaService, BASE_USER_LIMIT } from './user-quota.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConflictException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

describe('UserQuotaService', () => {
  let service: UserQuotaService;
  let prismaService: any;

  beforeEach(async () => {
    prismaService = {
      business: {
        findUnique: jest.fn(),
      },
      user: {
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserQuotaService,
        { provide: PrismaService, useValue: prismaService },
      ],
    }).compile();

    service = module.get<UserQuotaService>(UserQuotaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getUsage', () => {
    it('should throw if business is not found', async () => {
      prismaService.business.findUnique.mockResolvedValue(null);
      await expect(service.getUsage('b-1')).rejects.toThrow('Business not found');
    });

    it('should return correct usage when within limits', async () => {
      prismaService.business.findUnique.mockResolvedValue({ extraUserSlots: 0 });
      prismaService.user.count.mockResolvedValue(2); // 2 active users

      const usage = await service.getUsage('b-1');
      expect(usage.used).toBe(2);
      expect(usage.base).toBe(BASE_USER_LIMIT);
      expect(usage.extra).toBe(0);
      expect(usage.limit).toBe(BASE_USER_LIMIT);
      expect(usage.remaining).toBe(BASE_USER_LIMIT - 2);
    });

    it('should sum extra slots', async () => {
      prismaService.business.findUnique.mockResolvedValue({ extraUserSlots: 2 });
      prismaService.user.count.mockResolvedValue(7);

      const usage = await service.getUsage('b-1');
      expect(usage.used).toBe(7);
      expect(usage.base).toBe(BASE_USER_LIMIT);
      expect(usage.extra).toBe(2);
      expect(usage.limit).toBe(BASE_USER_LIMIT + 2); // 8
      expect(usage.remaining).toBe(1);
    });
  });

  describe('checkQuota', () => {
    it('should pass if under limit', async () => {
      prismaService.business.findUnique.mockResolvedValue({ extraUserSlots: 0 });
      prismaService.user.count.mockResolvedValue(5); // limit is 6, 5 used

      await expect(service.checkQuota('b-1')).resolves.not.toThrow();
    });

    it('should throw if exactly on limit', async () => {
      prismaService.business.findUnique.mockResolvedValue({ extraUserSlots: 0 });
      prismaService.user.count.mockResolvedValue(6);

      await expect(service.checkQuota('b-1')).rejects.toThrow(ConflictException);
    });

    it('should throw if over limit', async () => {
      prismaService.business.findUnique.mockResolvedValue({ extraUserSlots: 0 });
      prismaService.user.count.mockResolvedValue(7); // e.g. existing business over limit

      await expect(service.checkQuota('b-1')).rejects.toThrow(ConflictException);
    });
    
    it('should pass if at base limit but has extra slots', async () => {
      prismaService.business.findUnique.mockResolvedValue({ extraUserSlots: 1 });
      prismaService.user.count.mockResolvedValue(6);

      await expect(service.checkQuota('b-1')).resolves.not.toThrow();
    });
  });
});
