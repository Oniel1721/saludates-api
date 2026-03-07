import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { isAfter, isBefore, isEqual } from 'date-fns';
import { PrismaService } from '@/prisma/prisma.service';
import { BulkScheduleDto } from '@/modules/availability/dto/bulk-schedule.dto';
import { UpdateScheduleDayDto } from '@/modules/availability/dto/update-schedule-day.dto';
import { CreateTimeBlockDto } from '@/modules/availability/dto/create-time-block.dto';

export interface SlotCheckResult {
  available: boolean;
  reason?: string;
}

@Injectable()
export class AvailabilityService {
  constructor(private prisma: PrismaService) {}

  // ── Schedule ────────────────────────────────────────────────────────────────

  getSchedule(clinicId: string) {
    return this.prisma.schedule.findMany({
      where: { clinicId },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  async upsertSchedule(clinicId: string, dto: BulkScheduleDto) {
    const days = dto.schedule;

    for (const day of days) {
      if (day.isActive && day.startTime >= day.endTime) {
        throw new BadRequestException(
          `Day ${day.dayOfWeek}: startTime must be before endTime`,
        );
      }
    }

    await this.prisma.$transaction(
      days.map((day) =>
        this.prisma.schedule.upsert({
          where: { clinicId_dayOfWeek: { clinicId, dayOfWeek: day.dayOfWeek } },
          create: {
            clinicId,
            dayOfWeek: day.dayOfWeek,
            isActive: day.isActive,
            startTime: day.startTime ?? '08:00',
            endTime: day.endTime ?? '17:00',
          },
          update: {
            isActive: day.isActive,
            startTime: day.startTime ?? '08:00',
            endTime: day.endTime ?? '17:00',
          },
        }),
      ),
    );

    return this.getSchedule(clinicId);
  }

  async updateDay(clinicId: string, dayOfWeek: number, dto: UpdateScheduleDayDto) {
    const existing = await this.prisma.schedule.findUnique({
      where: { clinicId_dayOfWeek: { clinicId, dayOfWeek } },
    });
    if (!existing) throw new NotFoundException(`No schedule entry for day ${dayOfWeek}`);

    const startTime = dto.startTime ?? existing.startTime;
    const endTime = dto.endTime ?? existing.endTime;

    if ((dto.isActive ?? existing.isActive) && startTime >= endTime) {
      throw new BadRequestException('startTime must be before endTime');
    }

    return this.prisma.schedule.update({
      where: { clinicId_dayOfWeek: { clinicId, dayOfWeek } },
      data: { isActive: dto.isActive, startTime: dto.startTime, endTime: dto.endTime },
    });
  }

  // ── Time Blocks ─────────────────────────────────────────────────────────────

  getTimeBlocks(clinicId: string, upcoming: boolean) {
    return this.prisma.timeBlock.findMany({
      where: {
        clinicId,
        ...(upcoming ? { endDatetime: { gt: new Date() } } : {}),
      },
      orderBy: { startDatetime: 'asc' },
    });
  }

  createTimeBlock(clinicId: string, dto: CreateTimeBlockDto) {
    const start = new Date(dto.startDatetime);
    const end = new Date(dto.endDatetime);

    if (!isAfter(end, start)) {
      throw new BadRequestException('endDatetime must be after startDatetime');
    }

    return this.prisma.timeBlock.create({
      data: { clinicId, startDatetime: start, endDatetime: end, reason: dto.reason },
    });
  }

  async deleteTimeBlock(clinicId: string, blockId: string) {
    const block = await this.prisma.timeBlock.findFirst({
      where: { id: blockId, clinicId },
    });
    if (!block) throw new NotFoundException('Time block not found');
    return this.prisma.timeBlock.delete({ where: { id: blockId } });
  }

  // ── Availability validation (T-16) ──────────────────────────────────────────

  /**
   * Checks if a given time slot is available for booking.
   * Used by the appointments service and the bot flow.
   * Assumes datetimes are in the clinic's local timezone.
   *
   * @param excludeAppointmentId — skip this appointment when checking overlaps (for reschedules)
   */
  async checkSlot(
    clinicId: string,
    startsAt: Date,
    endsAt: Date,
    excludeAppointmentId?: string,
  ): Promise<SlotCheckResult> {
    if (!isAfter(startsAt, new Date())) {
      throw new BadRequestException('Cannot check availability for a past date');
    }

    // 1. Check base schedule
    const dayOfWeek = startsAt.getDay();
    const schedule = await this.prisma.schedule.findUnique({
      where: { clinicId_dayOfWeek: { clinicId, dayOfWeek } },
    });

    if (!schedule || !schedule.isActive) {
      return { available: false, reason: 'Clinic is closed on this day' };
    }

    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };

    const slotStartMin = startsAt.getHours() * 60 + startsAt.getMinutes();
    const slotEndMin = endsAt.getHours() * 60 + endsAt.getMinutes();
    const scheduleStartMin = toMinutes(schedule.startTime);
    const scheduleEndMin = toMinutes(schedule.endTime);

    if (slotStartMin < scheduleStartMin || slotEndMin > scheduleEndMin) {
      return { available: false, reason: 'Time slot is outside clinic hours' };
    }

    // 2. Check time blocks (blocked periods overlap the slot)
    const blockingBlock = await this.prisma.timeBlock.findFirst({
      where: {
        clinicId,
        startDatetime: { lt: endsAt },
        endDatetime: { gt: startsAt },
      },
    });

    if (blockingBlock) {
      return {
        available: false,
        reason: blockingBlock.reason
          ? `Clinic is unavailable: ${blockingBlock.reason}`
          : 'Clinic is unavailable during this period',
      };
    }

    // 3. Check appointment overlaps (non-cancelled)
    const overlappingAppointment = await this.prisma.appointment.findFirst({
      where: {
        clinicId,
        id: excludeAppointmentId ? { not: excludeAppointmentId } : undefined,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });

    if (overlappingAppointment) {
      return { available: false, reason: 'This time slot is already booked' };
    }

    return { available: true };
  }

  /**
   * Returns all available start times for a given date and service.
   * Slots are generated every `durationMinutes` within the clinic's schedule.
   */
  async getAvailableSlots(
    clinicId: string,
    date: string,
    serviceId: string,
    excludeAppointmentId?: string,
  ): Promise<string[]> {
    const parsedDate = new Date(date);
    parsedDate.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (isBefore(parsedDate, today)) {
      throw new BadRequestException('Cannot get available slots for a past date');
    }

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, clinicId, archivedAt: null },
    });
    if (!service) throw new NotFoundException('Service not found');

    const dayOfWeek = parsedDate.getDay();

    const schedule = await this.prisma.schedule.findUnique({
      where: { clinicId_dayOfWeek: { clinicId, dayOfWeek } },
    });

    if (!schedule || !schedule.isActive) return [];

    // Pre-fetch blocking data for that day to avoid N+1 queries
    const dayStart = new Date(parsedDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(parsedDate);
    dayEnd.setHours(23, 59, 59, 999);

    const [timeBlocks, appointments] = await Promise.all([
      this.prisma.timeBlock.findMany({
        where: {
          clinicId,
          startDatetime: { lt: dayEnd },
          endDatetime: { gt: dayStart },
        },
      }),
      this.prisma.appointment.findMany({
        where: {
          clinicId,
          status: { in: ['PENDING', 'CONFIRMED'] },
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
        },
      }),
    ]);

    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };

    const scheduleStartMin = toMinutes(schedule.startTime);
    const scheduleEndMin = toMinutes(schedule.endTime);
    const durationMin = service.durationMinutes;
    const availableSlots: string[] = [];

    const now = new Date();

    for (let min = scheduleStartMin; min + durationMin <= scheduleEndMin; min += durationMin) {
      const slotStart = new Date(parsedDate);
      slotStart.setHours(Math.floor(min / 60), min % 60, 0, 0);

      // Skip slots that have already started
      if (!isAfter(slotStart, now)) continue;

      const slotEnd = new Date(slotStart.getTime() + durationMin * 60_000);

      const blockedByTimeBlock = timeBlocks.some(
        (b) => isBefore(b.startDatetime, slotEnd) && isAfter(b.endDatetime, slotStart),
      );
      if (blockedByTimeBlock) continue;

      const blockedByAppointment = appointments.some(
        (a) =>
          a.id !== excludeAppointmentId &&
          isBefore(a.startsAt, slotEnd) &&
          isAfter(a.endsAt, slotStart),
      );
      if (blockedByAppointment) continue;

      availableSlots.push(slotStart.toISOString());
    }

    return availableSlots;
  }
}
