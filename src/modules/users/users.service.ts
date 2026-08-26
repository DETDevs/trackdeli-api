import { BadRequestException, ConflictException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRiderProfileDto } from './dto/update-rider-profile.dto';
import { UserResponseDto } from './dto/user-response.dto';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '@prisma/client';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
  ) {}

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

    this.logger.log(`[create] OK userId=${user.id}, email=${user.email}, rol=${user.role}, businessId=${businessId}`);
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

    this.logger.log(`[update] OK userId=${id}, camposModificados=${Object.keys(dto).join(',')}`);
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

    this.logger.log(`[deactivate] OK userId=${id} desactivado por requesterId=${requesterId}`);
    return this.toResponseDto(updatedUser);
  }

  async updateProfile(userId: string, dto: UpdateRiderProfileDto): Promise<UserResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== 'REPARTIDOR') {
      throw new BadRequestException('Solo los repartidores pueden actualizar este perfil');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.vehicleType !== undefined && { vehicleType: dto.vehicleType }),
        ...(dto.vehiclePlate !== undefined && { vehiclePlate: dto.vehiclePlate }),
        ...(dto.vehicleColor !== undefined && { vehicleColor: dto.vehicleColor }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
      },
    });

    this.logger.log(`[updateProfile] OK userId=${userId}`);
    return this.toResponseDto(updatedUser);
  }

  async uploadVehiclePhoto(userId: string, file: Express.Multer.File): Promise<{ url: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'REPARTIDOR') {
      throw new NotFoundException('Repartidor no encontrado');
    }

    if (user.vehiclePhotoUrl) {
      try {
        await this.uploadService.deletePhoto(user.vehiclePhotoUrl);
      } catch (e) {
        // Ignorar si no se pudo borrar la anterior
      }
    }

    const url = await this.uploadService.uploadPhoto(file, 'users/vehicles');
    
    await this.prisma.user.update({
      where: { id: userId },
      data: { vehiclePhotoUrl: url },
    });

    return { url };
  }

  async uploadProfilePhoto(userId: string, file: Express.Multer.File): Promise<{ url: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'REPARTIDOR') {
      throw new NotFoundException('Repartidor no encontrado');
    }

    if (user.profilePhotoUrl) {
      try {
        await this.uploadService.deletePhoto(user.profilePhotoUrl);
      } catch (e) {
        // Ignorar si no se pudo borrar la anterior
      }
    }

    const url = await this.uploadService.uploadPhoto(file, 'users/profiles');
    
    await this.prisma.user.update({
      where: { id: userId },
      data: { profilePhotoUrl: url },
    });

    return { url };
  }
}
