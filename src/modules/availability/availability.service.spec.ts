import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AvailabilityService } from '@/modules/availability/availability.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a future Date N hours from now */
const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);

/**
 * Returns a LOCAL date string (YYYY-MM-DD) N days from now.
 * Using local date avoids timezone mismatches when the service
 * does `new Date(date) + setHours(0,0,0,0)`.
 */
const localDateInDays = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
};

const makeSchedule = (startTime = '08:00', endTime = '17:00', isActive = true) => ({
  startTime,
  endTime,
  isActive,
});

// ─── AvailabilityService tests ────────────────────────────────────────────────

describe('AvailabilityService', () => {
  let service: AvailabilityService;
  let prisma: Record<string, jest.Mock>;

  beforeEach(() => {
    prisma = {
      schedule: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
      timeBlock: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), delete: jest.fn() },
      appointment: { findFirst: jest.fn(), findMany: jest.fn() },
      service: { findFirst: jest.fn() },
      $transaction: jest.fn((fns: unknown[]) => Promise.all((fns as (() => unknown)[]).map((f) => f()))),
    };
    service = new AvailabilityService(prisma as never);
  });

  // ── checkSlot ──────────────────────────────────────────────────────────────

  describe('checkSlot', () => {
    it('throws BadRequestException for a past startsAt', async () => {
      const past = new Date(Date.now() - 60_000);
      await expect(service.checkSlot('c1', past, inHours(1))).rejects.toThrow(BadRequestException);
    });

    it('returns unavailable when clinic is closed that day (no schedule)', async () => {
      prisma.schedule.findUnique.mockResolvedValue(null);
      const result = await service.checkSlot('c1', inHours(1), inHours(2));
      expect(result).toEqual({ available: false, reason: 'Clinic is closed on this day' });
    });

    it('returns unavailable when schedule is inactive', async () => {
      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00', false));
      const result = await service.checkSlot('c1', inHours(1), inHours(2));
      expect(result).toEqual({ available: false, reason: 'Clinic is closed on this day' });
    });

    it('returns unavailable when slot starts before clinic opens', async () => {
      // Force a date that will be at 07:00
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(7, 0, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000);

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue(null);
      prisma.appointment.findFirst.mockResolvedValue(null);

      const result = await service.checkSlot('c1', future, endsAt);
      expect(result).toEqual({ available: false, reason: 'Time slot is outside clinic hours' });
    });

    it('returns unavailable when slot ends after clinic closes', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(16, 45, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000); // 17:15

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue(null);
      prisma.appointment.findFirst.mockResolvedValue(null);

      const result = await service.checkSlot('c1', future, endsAt);
      expect(result).toEqual({ available: false, reason: 'Time slot is outside clinic hours' });
    });

    it('returns unavailable when a time block overlaps the slot', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(10, 0, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000);

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue({
        id: 'tb1',
        reason: 'Staff meeting',
        startDatetime: future,
        endDatetime: endsAt,
      });

      const result = await service.checkSlot('c1', future, endsAt);
      expect(result.available).toBe(false);
      expect(result.reason).toContain('Staff meeting');
    });

    it('returns unavailable when time block has no reason', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(10, 0, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000);

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue({ id: 'tb1', reason: null });

      const result = await service.checkSlot('c1', future, endsAt);
      expect(result.available).toBe(false);
      expect(result.reason).toBe('Clinic is unavailable during this period');
    });

    it('returns unavailable when an overlapping appointment exists', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(10, 0, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000);

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue(null);
      prisma.appointment.findFirst.mockResolvedValue({ id: 'a1' });

      const result = await service.checkSlot('c1', future, endsAt);
      expect(result).toEqual({ available: false, reason: 'This time slot is already booked' });
    });

    it('returns available when all checks pass', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(10, 0, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000);

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue(null);
      prisma.appointment.findFirst.mockResolvedValue(null);

      const result = await service.checkSlot('c1', future, endsAt);
      expect(result).toEqual({ available: true });
    });

    it('excludes the given appointment when checking overlaps', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(10, 0, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000);

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue(null);
      prisma.appointment.findFirst.mockResolvedValue(null);

      await service.checkSlot('c1', future, endsAt, 'appt-to-exclude');

      // Verify the exclusion was passed to Prisma
      const callArgs = prisma.appointment.findFirst.mock.calls[0][0];
      expect(callArgs.where.id).toEqual({ not: 'appt-to-exclude' });
    });

    it('does not add id filter when excludeAppointmentId is undefined', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 1);
      future.setHours(10, 0, 0, 0);
      const endsAt = new Date(future.getTime() + 30 * 60_000);

      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '17:00'));
      prisma.timeBlock.findFirst.mockResolvedValue(null);
      prisma.appointment.findFirst.mockResolvedValue(null);

      await service.checkSlot('c1', future, endsAt);

      const callArgs = prisma.appointment.findFirst.mock.calls[0][0];
      expect(callArgs.where.id).toBeUndefined();
    });
  });

  // ── getAvailableSlots ──────────────────────────────────────────────────────

  describe('getAvailableSlots', () => {
    const mockService = { id: 's1', durationMinutes: 30 };

    /**
     * Build a future base date at midnight LOCAL time N days from now.
     * The service does new Date(dateStr) + setHours(0,0,0,0), which also
     * resolves to local midnight, so both sides stay consistent.
     */
    const futureBase = (days: number) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(0, 0, 0, 0);
      return d;
    };

    /** Convert a local Date to the YYYY-MM-DD string the service expects. */
    const toLocalDateStr = (d: Date) => {
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const dy = String(d.getDate()).padStart(2, '0');
      return `${y}-${mo}-${dy}`;
    };

    it('throws BadRequestException for a past date', async () => {
      await expect(service.getAvailableSlots('c1', localDateInDays(-1), 's1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when service does not exist', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(service.getAvailableSlots('c1', localDateInDays(1), 's1')).rejects.toThrow(NotFoundException);
    });

    it('returns empty array when clinic is closed that day', async () => {
      prisma.service.findFirst.mockResolvedValue(mockService);
      prisma.schedule.findUnique.mockResolvedValue(null);
      const slots = await service.getAvailableSlots('c1', localDateInDays(1), 's1');
      expect(slots).toEqual([]);
    });

    it('returns empty array when schedule is inactive', async () => {
      prisma.service.findFirst.mockResolvedValue(mockService);
      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '09:00', false));
      const slots = await service.getAvailableSlots('c1', localDateInDays(1), 's1');
      expect(slots).toEqual([]);
    });

    it('returns available slots with no blockers', async () => {
      // Use 30 days from now so 08:00 LOCAL is definitely future in any timezone
      const base = futureBase(30);
      prisma.service.findFirst.mockResolvedValue(mockService);
      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '09:00'));
      prisma.timeBlock.findMany.mockResolvedValue([]);
      prisma.appointment.findMany.mockResolvedValue([]);

      const slots = await service.getAvailableSlots('c1', toLocalDateStr(base), 's1');
      // 08:00–09:00 with 30-min duration → 2 slots: 08:00, 08:30
      expect(slots).toHaveLength(2);
    });

    it('excludes slots blocked by a time block', async () => {
      const base = futureBase(30);
      // Mirror the service's parsedDate logic: new Date(dateStr) → setHours(0,0,0,0)
      // so the block lands on the exact same Date object the service uses for slot generation.
      const dateStr = toLocalDateStr(base);
      const parsedDate = new Date(dateStr);
      parsedDate.setHours(0, 0, 0, 0);
      const blockStart = new Date(parsedDate); blockStart.setHours(8, 0, 0, 0);
      const blockEnd   = new Date(parsedDate); blockEnd.setHours(8, 30, 0, 0);

      prisma.service.findFirst.mockResolvedValue(mockService);
      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '09:00'));
      prisma.timeBlock.findMany.mockResolvedValue([{ startDatetime: blockStart, endDatetime: blockEnd }]);
      prisma.appointment.findMany.mockResolvedValue([]);

      const slots = await service.getAvailableSlots('c1', dateStr, 's1');
      // 08:00 blocked → only 08:30 remains
      expect(slots).toHaveLength(1);
    });

    it('excludes slots blocked by an appointment', async () => {
      const base = futureBase(30);
      const dateStr = toLocalDateStr(base);
      const parsedDate = new Date(dateStr);
      parsedDate.setHours(0, 0, 0, 0);
      const apptStart = new Date(parsedDate); apptStart.setHours(8, 0, 0, 0);
      const apptEnd   = new Date(parsedDate); apptEnd.setHours(8, 30, 0, 0);

      prisma.service.findFirst.mockResolvedValue(mockService);
      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '09:00'));
      prisma.timeBlock.findMany.mockResolvedValue([]);
      prisma.appointment.findMany.mockResolvedValue([{ id: 'a1', startsAt: apptStart, endsAt: apptEnd }]);

      const slots = await service.getAvailableSlots('c1', dateStr, 's1');
      expect(slots).toHaveLength(1);
    });

    it('does not block slot when excludeAppointmentId matches', async () => {
      const base = futureBase(30);
      const apptStart = new Date(base); apptStart.setHours(8, 0, 0, 0);
      const apptEnd   = new Date(base); apptEnd.setHours(8, 30, 0, 0);

      prisma.service.findFirst.mockResolvedValue(mockService);
      prisma.schedule.findUnique.mockResolvedValue(makeSchedule('08:00', '09:00'));
      prisma.timeBlock.findMany.mockResolvedValue([]);
      prisma.appointment.findMany.mockResolvedValue([{ id: 'to-exclude', startsAt: apptStart, endsAt: apptEnd }]);

      const slots = await service.getAvailableSlots('c1', toLocalDateStr(base), 's1', 'to-exclude');
      // Excluded appointment no longer blocks → both slots free
      expect(slots).toHaveLength(2);
    });

  });

  // ── upsertSchedule ─────────────────────────────────────────────────────────

  describe('upsertSchedule', () => {
    it('throws BadRequestException when startTime >= endTime for active day', async () => {
      prisma.schedule.findMany.mockResolvedValue([]);
      await expect(
        service.upsertSchedule('c1', {
          schedule: [{ dayOfWeek: 1, isActive: true, startTime: '17:00', endTime: '08:00' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts equal startTime/endTime for inactive day', async () => {
      prisma.schedule.findMany.mockResolvedValue([]);
      prisma.$transaction.mockResolvedValue([{}]);
      await expect(
        service.upsertSchedule('c1', {
          schedule: [{ dayOfWeek: 0, isActive: false, startTime: '08:00', endTime: '08:00' }],
        }),
      ).resolves.not.toThrow();
    });
  });

  // ── createTimeBlock ────────────────────────────────────────────────────────

  describe('createTimeBlock', () => {
    it('throws BadRequestException when end is not after start', () => {
      // createTimeBlock throws synchronously before returning a Promise
      const start = inHours(2);
      const end = inHours(1);
      expect(() =>
        service.createTimeBlock('c1', {
          startDatetime: start.toISOString(),
          endDatetime: end.toISOString(),
          reason: 'test',
        }),
      ).toThrow(BadRequestException);
    });

    it('creates a time block when end is after start', async () => {
      prisma.timeBlock.create.mockResolvedValue({ id: 'tb1' });
      const start = inHours(1);
      const end = inHours(3);
      await service.createTimeBlock('c1', {
        startDatetime: start.toISOString(),
        endDatetime: end.toISOString(),
        reason: 'meeting',
      });
      expect(prisma.timeBlock.create).toHaveBeenCalledTimes(1);
    });
  });

  // ── deleteTimeBlock ────────────────────────────────────────────────────────

  describe('deleteTimeBlock', () => {
    it('throws NotFoundException when block does not exist', async () => {
      prisma.timeBlock.findFirst.mockResolvedValue(null);
      await expect(service.deleteTimeBlock('c1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('deletes existing time block', async () => {
      prisma.timeBlock.findFirst.mockResolvedValue({ id: 'tb1' });
      prisma.timeBlock.delete.mockResolvedValue({ id: 'tb1' });
      await service.deleteTimeBlock('c1', 'tb1');
      expect(prisma.timeBlock.delete).toHaveBeenCalledWith({ where: { id: 'tb1' } });
    });
  });
});
