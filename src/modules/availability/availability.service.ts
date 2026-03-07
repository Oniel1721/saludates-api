import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { BulkScheduleDto } from '@/modules/availability/dto/bulk-schedule.dto';
import { UpdateScheduleDayDto } from '@/modules/availability/dto/update-schedule-day.dto';
import { CreateTimeBlockDto } from '@/modules/availability/dto/create-time-block.dto';

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

    // Validate: active days must have startTime < endTime
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

    if (end <= start) {
      throw new BadRequestException('endDatetime must be after startDatetime');
    }

    return this.prisma.timeBlock.create({
      data: {
        clinicId,
        startDatetime: start,
        endDatetime: end,
        reason: dto.reason,
      },
    });
  }

  async deleteTimeBlock(clinicId: string, blockId: string) {
    const block = await this.prisma.timeBlock.findFirst({
      where: { id: blockId, clinicId },
    });
    if (!block) throw new NotFoundException('Time block not found');

    return this.prisma.timeBlock.delete({ where: { id: blockId } });
  }
}
