import { Test, TestingModule } from '@nestjs/testing';
import { PosUsersService } from './pos-users.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { UserQuotaService } from '../../users/user-quota.service';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

describe('PosUsersService', () => {
  let service: PosUsersService;
  let prismaService: any;
  let quotaService: any;

  beforeEach(async () => {
    prismaService = {
      user: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      business: {
        findUnique: jest.fn(),
      }
    };

    quotaService = {
      getUsage: jest.fn(),
      checkQuota: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PosUsersService,
        { provide: PrismaService, useValue: prismaService },
        { provide: UserQuotaService, useValue: quotaService },
      ],
    }).compile();

    service = module.get<PosUsersService>(PosUsersService);
  });

  describe('createUser', () => {
    it('should reject creating WAITER role', async () => {
      await expect(service.createUser('b-1', { role: UserRole.WAITER }, 'u-1'))
        .rejects.toThrow(UnprocessableEntityException);
    });

    it('should reject creating ENCARGADO role', async () => {
      await expect(service.createUser('b-1', { role: UserRole.ENCARGADO }, 'u-1'))
        .rejects.toThrow(UnprocessableEntityException);
    });

    it('should create CAJERO if quota allows', async () => {
      quotaService.checkQuota.mockResolvedValue();
      prismaService.user.create.mockResolvedValue({ id: 'new-user', role: UserRole.CAJERO });

      const result = await service.createUser('b-1', { role: UserRole.CAJERO, name: 'Test' }, 'u-1');
      expect(result.user.id).toBe('new-user');
      expect(result.tempPassword).toBeDefined();
    });
  });

  describe('updateUser', () => {
    it('should prevent user from changing their own role', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: 'u-1', businessId: 'b-1' });
      await expect(service.updateUser('b-1', 'u-1', { role: UserRole.CAJERO }, 'u-1'))
        .rejects.toThrow(ForbiddenException);
    });

    it('should prevent assigning WAITER role', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: 'u-2', businessId: 'b-1' });
      await expect(service.updateUser('b-1', 'u-2', { role: UserRole.WAITER }, 'u-1'))
        .rejects.toThrow(UnprocessableEntityException);
    });
    
    it('should allow ENCARGADO to update another user to CAJERO', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: 'u-2', businessId: 'b-1' });
      prismaService.user.update.mockResolvedValue({ id: 'u-2', role: UserRole.CAJERO });
      const result = await service.updateUser('b-1', 'u-2', { role: UserRole.CAJERO }, 'u-1');
      expect(result.role).toBe(UserRole.CAJERO);
    });
  });

  describe('deactivateUser', () => {
    it('should isolate by businessId (cannot deactivate user from other business)', async () => {
      prismaService.user.findFirst.mockResolvedValue(null);
      await expect(service.deactivateUser('b-1', 'u-2', 'u-1'))
        .rejects.toThrow('Usuario no encontrado');
    });

    it('should prevent user from deactivating themselves', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: 'u-1', businessId: 'b-1' });
      await expect(service.deactivateUser('b-1', 'u-1', 'u-1'))
        .rejects.toThrow(ForbiddenException);
    });

    it('should prevent deactivating the last active ENCARGADO', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: 'u-2', businessId: 'b-1', role: UserRole.ENCARGADO });
      prismaService.user.count.mockResolvedValue(0);
      await expect(service.deactivateUser('b-1', 'u-2', 'u-1'))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });
});
