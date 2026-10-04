import { Test, TestingModule } from '@nestjs/testing';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

describe('SettingsService', () => {
  let service: SettingsService;
  let prisma: PrismaService;

  const mockPrisma = {
    business: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<SettingsService>(SettingsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('updateSettings', () => {
    const businessId = 'biz-1';
    const userId = 'user-1';

    it('should allow ENCARGADO to update business fields', async () => {
      mockPrisma.business.findUnique.mockResolvedValue({ id: businessId, taxRate: 0 });
      mockPrisma.business.update.mockResolvedValue({ id: businessId });
      
      // We mock getSettings since it's called at the end
      jest.spyOn(service, 'getSettings').mockResolvedValue({ taxRate: 15 } as any);

      await service.updateSettings(businessId, { taxRate: 15 }, UserRole.ENCARGADO, userId);
      expect(mockPrisma.business.update).toHaveBeenCalledWith({
        where: { id: businessId },
        data: { taxRate: 15 },
        select: { id: true }
      });
    });

    it('should deny CAJERO from updating business fields with 403', async () => {
      mockPrisma.business.findUnique.mockResolvedValue({ id: businessId, taxRate: 0 });
      
      await expect(service.updateSettings(businessId, { taxRate: 15 }, UserRole.CAJERO, userId))
        .rejects
        .toThrow(ForbiddenException);
    });

    it('should allow CAJERO to update station fields (partial update does not touch business fields)', async () => {
      mockPrisma.business.findUnique.mockResolvedValue({ id: businessId });
      jest.spyOn(service, 'getSettings').mockResolvedValue({} as any);

      // Sending only printer fields (which are not business fields)
      await service.updateSettings(businessId, { printerCopies: 2 }, UserRole.CAJERO, userId);
      
      // update is NOT called for business fields because dataToUpdate is empty
      expect(mockPrisma.business.update).not.toHaveBeenCalled();
    });
  });
});
