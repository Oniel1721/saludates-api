import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CreateServiceDto } from '@/modules/services/dto/create-service.dto';
import { UpdateServiceDto } from '@/modules/services/dto/update-service.dto';

@Injectable()
export class ServicesService {
  constructor(private prisma: PrismaService) {}

  create(clinicId: string, dto: CreateServiceDto) {
    return this.prisma.service.create({
      data: {
        clinicId,
        name: dto.name,
        price: dto.price,
        durationMinutes: dto.durationMinutes,
        prerequisites: dto.prerequisites,
      },
    });
  }

  findAll(clinicId: string, includeArchived = false) {
    return this.prisma.service.findMany({
      where: {
        clinicId,
        // Only active services by default (no parentless archived ones visible)
        // "active" means archivedAt is null AND it has no child (it's the latest version)
        archivedAt: includeArchived ? undefined : null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(clinicId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, clinicId },
    });
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async update(clinicId: string, serviceId: string, dto: UpdateServiceDto) {
    const service = await this.findOne(clinicId, serviceId);

    if (service.archivedAt) {
      throw new BadRequestException('Cannot edit an archived service');
    }

    // Price changed: archive current version and create a new one
    if (dto.price !== undefined && dto.price !== service.price) {
      return this.prisma.$transaction(async (tx) => {
        await tx.service.update({
          where: { id: serviceId },
          data: { archivedAt: new Date() },
        });

        return tx.service.create({
          data: {
            clinicId,
            name: dto.name ?? service.name,
            price: dto.price!,
            durationMinutes: dto.durationMinutes ?? service.durationMinutes,
            prerequisites: dto.prerequisites !== undefined ? dto.prerequisites : service.prerequisites,
            parentServiceId: serviceId,
          },
        });
      });
    }

    // No price change: update in place
    return this.prisma.service.update({
      where: { id: serviceId },
      data: {
        name: dto.name,
        durationMinutes: dto.durationMinutes,
        prerequisites: dto.prerequisites,
      },
    });
  }

  async archive(clinicId: string, serviceId: string) {
    const service = await this.findOne(clinicId, serviceId);

    if (service.archivedAt) {
      throw new BadRequestException('Service is already archived');
    }

    return this.prisma.service.update({
      where: { id: serviceId },
      data: { archivedAt: new Date() },
    });
  }
}
