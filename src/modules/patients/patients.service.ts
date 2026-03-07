import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

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
