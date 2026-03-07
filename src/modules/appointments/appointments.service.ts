import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { AvailabilityService } from '@/modules/availability/availability.service';
import { CreateAppointmentDto } from '@/modules/appointments/dto/create-appointment.dto';
import { UpdateAppointmentDto } from '@/modules/appointments/dto/update-appointment.dto';
import { CancelAppointmentDto } from '@/modules/appointments/dto/cancel-appointment.dto';
import { MarkResultDto } from '@/modules/appointments/dto/mark-result.dto';

@Injectable()
export class AppointmentsService {
  constructor(
    private prisma: PrismaService,
    private availability: AvailabilityService,
  ) {}

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async findAppointmentOrThrow(clinicId: string, appointmentId: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      include: { patient: true, service: true },
    });
    if (!appointment) throw new NotFoundException('Appointment not found');
    return appointment;
  }

  /** Find or create patient by phone within a clinic (T-19) */
  private async findOrCreatePatient(clinicId: string, name: string, phone: string) {
    return this.prisma.patient.upsert({
      where: { clinicId_phone: { clinicId, phone } },
      create: { clinicId, name, phone },
      update: {},
    });
  }

  private computeEndsAt(startsAt: Date, durationMinutes: number): Date {
    return new Date(startsAt.getTime() + durationMinutes * 60_000);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  /** List appointments for calendar (T-10). Filter by date range. */
  findAll(clinicId: string, from?: string, to?: string) {
    return this.prisma.appointment.findMany({
      where: {
        clinicId,
        ...(from || to
          ? {
              startsAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
              },
            }
          : {}),
      },
      include: { patient: true, service: true },
      orderBy: { startsAt: 'asc' },
    });
  }

  findOne(clinicId: string, appointmentId: string) {
    return this.findAppointmentOrThrow(clinicId, appointmentId);
  }

  /** Create appointment from web app (T-12) */
  async create(clinicId: string, dto: CreateAppointmentDto) {
    const service = await this.prisma.service.findFirst({
      where: { id: dto.serviceId, clinicId, archivedAt: null },
    });
    if (!service) throw new NotFoundException('Service not found');

    const startsAt = new Date(dto.startsAt);

    if (startsAt <= new Date()) {
      throw new BadRequestException('Cannot create an appointment in the past');
    }

    const endsAt = this.computeEndsAt(startsAt, service.durationMinutes);
    const { available, reason } = await this.availability.checkSlot(clinicId, startsAt, endsAt);

    if (!available) throw new ConflictException(reason);

    const patient = await this.findOrCreatePatient(clinicId, dto.patientName, dto.patientPhone);

    return this.prisma.appointment.create({
      data: {
        clinicId,
        patientId: patient.id,
        serviceId: service.id,
        startsAt,
        endsAt,
        price: dto.price ?? service.price,
        status: 'PENDING',
        createdBy: 'SECRETARY',
      },
      include: { patient: true, service: true },
    });
  }

  /** Edit appointment from web app (T-13) */
  async update(clinicId: string, appointmentId: string, dto: UpdateAppointmentDto) {
    const appointment = await this.findAppointmentOrThrow(clinicId, appointmentId);

    if (!['PENDING', 'CONFIRMED'].includes(appointment.status)) {
      throw new BadRequestException(
        `Cannot edit an appointment with status ${appointment.status}`,
      );
    }

    // Resolve service (new or existing)
    const service = dto.serviceId
      ? await this.prisma.service.findFirst({
          where: { id: dto.serviceId, clinicId, archivedAt: null },
        })
      : appointment.service;

    if (!service) throw new NotFoundException('Service not found');

    // Resolve new datetime
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : appointment.startsAt;
    const endsAt = this.computeEndsAt(startsAt, service.durationMinutes);

    // Re-check availability if the slot changed (different start OR different duration)
    const slotChanged =
      startsAt.getTime() !== appointment.startsAt.getTime() ||
      endsAt.getTime() !== appointment.endsAt.getTime();

    if (slotChanged) {
      const { available, reason } = await this.availability.checkSlot(
        clinicId,
        startsAt,
        endsAt,
        appointmentId,
      );
      if (!available) throw new ConflictException(reason);
    }

    // Update patient name if provided
    if (dto.patientName) {
      await this.prisma.patient.update({
        where: { id: appointment.patientId },
        data: { name: dto.patientName },
      });
    }

    // Only a startsAt change (date/time) resets CONFIRMED → PENDING (PRD rule)
    const datetimeChanged = !!dto.startsAt && startsAt.getTime() !== appointment.startsAt.getTime();
    const newStatus =
      datetimeChanged && appointment.status === 'CONFIRMED' ? 'PENDING' : appointment.status;

    return this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        serviceId: service.id,
        startsAt,
        endsAt,
        price: dto.price ?? appointment.price,
        status: newStatus,
      },
      include: { patient: true, service: true },
    });
  }

  /** Cancel appointment from web app (T-14) */
  async cancel(clinicId: string, appointmentId: string, dto: CancelAppointmentDto) {
    const appointment = await this.findAppointmentOrThrow(clinicId, appointmentId);

    if (!['PENDING', 'CONFIRMED'].includes(appointment.status)) {
      throw new BadRequestException(
        `Cannot cancel an appointment with status ${appointment.status}`,
      );
    }

    return this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: 'CANCELLED',
        cancelledBy: 'SECRETARY',
        cancelledAt: new Date(),
        cancelReason: dto.reason,
      },
      include: { patient: true, service: true },
    });
  }

  /** Mark result after the appointment time has passed (T-15) */
  async markResult(clinicId: string, appointmentId: string, dto: MarkResultDto) {
    const appointment = await this.findAppointmentOrThrow(clinicId, appointmentId);

    if (appointment.startsAt > new Date()) {
      throw new BadRequestException('Cannot mark result before the appointment time has passed');
    }

    // Allow marking only from PENDING/CONFIRMED, or correcting between COMPLETED/NO_SHOW
    const validStatuses = ['PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'];
    if (!validStatuses.includes(appointment.status)) {
      throw new BadRequestException(
        `Cannot mark result on an appointment with status ${appointment.status}`,
      );
    }

    return this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: dto.status },
      include: { patient: true, service: true },
    });
  }
}
