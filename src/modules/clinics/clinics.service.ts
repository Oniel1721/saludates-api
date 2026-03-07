import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CreateClinicDto } from '@/modules/clinics/dto/create-clinic.dto';
import { UpdateClinicDto } from '@/modules/clinics/dto/update-clinic.dto';
import { UpdateClinicEmailsDto } from '@/modules/clinics/dto/update-clinic-emails.dto';

@Injectable()
export class ClinicsService {
  constructor(private prisma: PrismaService) {}

  create(dto: CreateClinicDto) {
    return this.prisma.clinic.create({
      data: {
        name: dto.name,
        address: dto.address,
        authorizedEmails: dto.authorizedEmails,
      },
    });
  }

  findAll() {
    return this.prisma.clinic.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(clinicId: string) {
    const clinic = await this.prisma.clinic.findUnique({ where: { id: clinicId } });
    if (!clinic) throw new NotFoundException('Clinic not found');
    return clinic;
  }

  async update(clinicId: string, dto: UpdateClinicDto) {
    await this.findOne(clinicId);
    return this.prisma.clinic.update({
      where: { id: clinicId },
      data: dto,
    });
  }

  async updateEmails(clinicId: string, dto: UpdateClinicEmailsDto) {
    await this.findOne(clinicId);
    return this.prisma.clinic.update({
      where: { id: clinicId },
      data: { authorizedEmails: dto.authorizedEmails },
    });
  }
}
