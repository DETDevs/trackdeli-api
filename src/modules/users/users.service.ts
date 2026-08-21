import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private toResponseDto(user: User): UserResponseDto {
    const { passwordHash, ...rest } = user;
    return rest as UserResponseDto;
  }

  async findAllByBusiness(businessId: string): Promise<UserResponseDto[]> {
    const users = await this.prisma.user.findMany({
      where: {
        businessId,
        role: UserRole.REPARTIDOR,
      },
      orderBy: {
        name: 'asc',
      },
    });

    return users.map(this.toResponseDto);
  }

  async findOne(id: string, businessId: string): Promise<UserResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user || user.businessId !== businessId) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return this.toResponseDto(user);
  }

  async create(dto: CreateUserDto, businessId: string): Promise<UserResponseDto> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email ya registrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        passwordHash,
        role: UserRole.REPARTIDOR,
        businessId,
      },
    });

    return this.toResponseDto(user);
  }

  async update(id: string, dto: UpdateUserDto, businessId: string): Promise<UserResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user || user.businessId !== businessId) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    return this.toResponseDto(updatedUser);
  }

  async deactivate(id: string, businessId: string, requesterId: string): Promise<UserResponseDto> {
    if (id === requesterId) {
      throw new BadRequestException('No puedes desactivarte a ti mismo');
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user || user.businessId !== businessId) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    return this.toResponseDto(updatedUser);
  }
}
