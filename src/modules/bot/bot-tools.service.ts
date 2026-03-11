import { Injectable } from '@nestjs/common';
import { CancelledBy, CreatedBy } from '@prisma/client';
import { addDays, differenceInHours, format, isAfter } from 'date-fns';
import { PrismaService } from '@/prisma/prisma.service';
import { AvailabilityService } from '@/modules/availability/availability.service';

const LOOK_AHEAD_DAYS = 14;
const MAX_SLOTS = 8;

export type ToolResult = Record<string, unknown>;

/**
 * Implements all business-logic tools that the AgentService can call on behalf of Claude.
 * Each method corresponds to one tool in the tools array.
 */
@Injectable()
export class BotToolsService {
  constructor(
    private prisma: PrismaService,
    private availability: AvailabilityService,
  ) {}

  async getServices(clinicId: string): Promise<ToolResult> {
    const services = await this.prisma.service.findMany({
      where: { clinicId, archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, price: true, durationMinutes: true, prerequisites: true },
    });
    return { services };
  }

  async getPatientAppointments(clinicId: string, patientId: string): Promise<ToolResult> {
    const appointments = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        patientId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { gte: new Date() },
      },
      include: { service: { select: { name: true, durationMinutes: true } } },
      orderBy: { startsAt: 'asc' },
    });
    return {
      appointments: appointments.map((a) => ({
        id: a.id,
        serviceName: a.service.name,
        durationMinutes: a.service.durationMinutes,
        startsAt: a.startsAt.toISOString(),
        status: a.status,
        price: a.price,
      })),
    };
  }

  async findAvailableSlots(
    clinicId: string,
    input: {
      serviceId: string;
      startDate?: string;
      endDate?: string;
      timePreference?: 'morning' | 'afternoon' | 'evening';
      excludeAppointmentId?: string;
    },
  ): Promise<ToolResult> {
    const start = input.startDate ? new Date(input.startDate) : new Date();
    const end = input.endDate ? new Date(input.endDate) : addDays(start, LOOK_AHEAD_DAYS);

    const slots: string[] = [];

    for (let d = new Date(start); d <= end && slots.length < MAX_SLOTS; d = addDays(d, 1)) {
      try {
        const daySlots = await this.availability.getAvailableSlots(
          clinicId,
          format(d, 'yyyy-MM-dd'),
          input.serviceId,
          input.excludeAppointmentId,
        );
        for (const s of daySlots) {
          if (input.timePreference) {
            const h = new Date(s).getHours();
            if (input.timePreference === 'morning' && h >= 12) continue;
            if (input.timePreference === 'afternoon' && (h < 12 || h >= 18)) continue;
            if (input.timePreference === 'evening' && h < 18) continue;
          }
          slots.push(s);
          if (slots.length >= MAX_SLOTS) break;
        }
      } catch {
        continue;
      }
    }

    return { availableSlots: slots };
  }

  async createAppointment(
    clinicId: string,
    patientId: string,
    input: { serviceId: string; startsAt: string },
  ): Promise<ToolResult> {
    const service = await this.prisma.service.findFirst({
      where: { id: input.serviceId, clinicId, archivedAt: null },
    });
    if (!service) return { error: 'Servicio no encontrado.' };

    const startsAt = new Date(input.startsAt);
    if (!isAfter(startsAt, new Date())) {
      return { error: 'La fecha seleccionada ya pasó.' };
    }

    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
    const { available, reason } = await this.availability.checkSlot(clinicId, startsAt, endsAt);
    if (!available) return { error: `Horario no disponible: ${reason}` };

    const hoursUntil = differenceInHours(startsAt, new Date());
    const status = hoursUntil > 24 ? 'PENDING' : 'CONFIRMED';

    const appointment = await this.prisma.appointment.create({
      data: {
        clinicId,
        patientId,
        serviceId: input.serviceId,
        startsAt,
        endsAt,
        price: service.price,
        status,
        createdBy: CreatedBy.BOT,
      },
    });

    return {
      success: true,
      appointmentId: appointment.id,
      status,
      startsAt: appointment.startsAt.toISOString(),
      serviceName: service.name,
      price: service.price,
      hoursUntil,
    };
  }

  async cancelAppointment(clinicId: string, input: { appointmentId: string }): Promise<ToolResult> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: input.appointmentId, clinicId },
    });
    if (!appointment) return { error: 'Cita no encontrada.' };
    if (!['PENDING', 'CONFIRMED'].includes(appointment.status)) {
      return { error: `La cita no puede ser cancelada (estado: ${appointment.status}).` };
    }

    await this.prisma.appointment.update({
      where: { id: input.appointmentId },
      data: { status: 'CANCELLED', cancelledBy: CancelledBy.PATIENT, cancelledAt: new Date() },
    });

    return { success: true };
  }

  async rescheduleAppointment(
    clinicId: string,
    input: { appointmentId: string; newStartsAt: string },
  ): Promise<ToolResult> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: input.appointmentId, clinicId },
      include: { service: true },
    });
    if (!appointment) return { error: 'Cita no encontrada.' };
    if (!['PENDING', 'CONFIRMED'].includes(appointment.status)) {
      return { error: 'La cita no puede ser reagendada.' };
    }

    const newStartsAt = new Date(input.newStartsAt);
    if (!isAfter(newStartsAt, new Date())) {
      return { error: 'La nueva fecha ya pasó.' };
    }

    const newEndsAt = new Date(newStartsAt.getTime() + appointment.service.durationMinutes * 60_000);
    const { available, reason } = await this.availability.checkSlot(
      clinicId,
      newStartsAt,
      newEndsAt,
      input.appointmentId,
    );
    if (!available) return { error: `Horario no disponible: ${reason}` };

    await this.prisma.appointment.update({
      where: { id: input.appointmentId },
      data: { startsAt: newStartsAt, endsAt: newEndsAt, status: 'PENDING', reminderSentAt: null },
    });

    return { success: true, newStartsAt: newStartsAt.toISOString() };
  }

  async confirmAppointment(clinicId: string, input: { appointmentId: string }): Promise<ToolResult> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: input.appointmentId, clinicId },
    });
    if (!appointment) return { error: 'Cita no encontrada.' };
    if (appointment.status !== 'PENDING') {
      return { error: `La cita no está pendiente (estado: ${appointment.status}).` };
    }

    await this.prisma.appointment.update({
      where: { id: input.appointmentId },
      data: { status: 'CONFIRMED' },
    });

    return { success: true };
  }

  async executeTool(
    toolName: string,
    input: Record<string, unknown>,
    clinicId: string,
    patientId: string,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'get_services':
        return this.getServices(clinicId);
      case 'get_patient_appointments':
        return this.getPatientAppointments(clinicId, patientId);
      case 'find_available_slots':
        return this.findAvailableSlots(
          clinicId,
          input as Parameters<typeof this.findAvailableSlots>[1],
        );
      case 'create_appointment':
        return this.createAppointment(clinicId, patientId, input as { serviceId: string; startsAt: string });
      case 'cancel_appointment':
        return this.cancelAppointment(clinicId, input as { appointmentId: string });
      case 'reschedule_appointment':
        return this.rescheduleAppointment(clinicId, input as { appointmentId: string; newStartsAt: string });
      case 'confirm_appointment':
        return this.confirmAppointment(clinicId, input as { appointmentId: string });
      default:
        return { error: `Herramienta desconocida: ${toolName}` };
    }
  }
}
