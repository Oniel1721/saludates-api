import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { UpdatePatientDto } from '@/modules/patients/dto/update-patient.dto';

@Injectable()
export class PatientsService {
  constructor(private prisma: PrismaService) {}

  /** Searchable contact list (T-17). Searches by name or phone. */
  findAll(clinicId: string, search?: string) {
    return this.prisma.patient.findMany({
      where: {
        clinicId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  async update(clinicId: string, patientId: string, dto: UpdatePatientDto) {
    await this.findOne(clinicId, patientId);
    return this.prisma.patient.update({
      where: { id: patientId },
      data: { name: dto.name },
    });
  }

  /** Patient profile with full appointment history (T-18). */
  async findOne(clinicId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, clinicId },
      include: {
        appointments: {
          include: { service: true },
          orderBy: { startsAt: 'desc' },
        },
      },
    });

    if (!patient) throw new NotFoundException('Patient not found');
    return patient;
  }
}
