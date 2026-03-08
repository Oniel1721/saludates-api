import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AppointmentsService } from '@/modules/appointments/appointments.service';

describe('AppointmentsService', () => {
  let service: AppointmentsService;
  let prisma: Record<string, jest.Mock>;
  let availability: { checkSlot: jest.Mock };
  let whatsappMessages: { sendCreatedBySecretary: jest.Mock; sendUpdatedBySecretary: jest.Mock; sendCancelledBySecretary: jest.Mock };

  const future = (offsetMs = 60 * 60 * 1000) => new Date(Date.now() + offsetMs);
  const past = () => new Date(Date.now() - 60_000);

  const makeAppointment = (overrides = {}) => ({
    id: 'appt1',
    clinicId: 'c1',
    patientId: 'p1',
    serviceId: 's1',
    startsAt: future(2 * 3600_000),
    endsAt: future(2.5 * 3600_000),
    price: 1500,
    status: 'PENDING',
    createdBy: 'SECRETARY',
    reminderSentAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    patient: { id: 'p1', name: 'John', phone: '18091234567' },
    service: { id: 's1', name: 'Consulta', durationMinutes: 30, price: 1500 },
    ...overrides,
  });

  const makeService = (overrides = {}) => ({
    id: 's1',
    name: 'Consulta',
    price: 1500,
    durationMinutes: 30,
    archivedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      appointment: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      service: { findFirst: jest.fn() },
      patient: { upsert: jest.fn(), update: jest.fn() },
      // Supports both batch form ($transaction([...])) and callback form ($transaction(async tx => ...))
      $transaction: jest.fn((cbOrArray: unknown) =>
        typeof cbOrArray === 'function'
          ? (cbOrArray as (tx: unknown) => unknown)(prisma)
          : Promise.all((cbOrArray as (() => unknown)[]).map((f: () => unknown) => f())),
      ),
    };
    availability = { checkSlot: jest.fn() };
    whatsappMessages = {
      sendCreatedBySecretary: jest.fn().mockResolvedValue(undefined),
      sendUpdatedBySecretary: jest.fn().mockResolvedValue(undefined),
      sendCancelledBySecretary: jest.fn().mockResolvedValue(undefined),
    };
    service = new AppointmentsService(prisma as never, availability as never, whatsappMessages as never);
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('throws NotFoundException when service does not exist', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(
        service.create('c1', { serviceId: 's1', startsAt: future().toISOString(), patientName: 'John', patientPhone: '1809' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for a past startsAt', async () => {
      prisma.service.findFirst.mockResolvedValue(makeService());
      await expect(
        service.create('c1', { serviceId: 's1', startsAt: past().toISOString(), patientName: 'John', patientPhone: '1809' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when slot is not available', async () => {
      prisma.service.findFirst.mockResolvedValue(makeService());
      availability.checkSlot.mockResolvedValue({ available: false, reason: 'Already booked' });
      await expect(
        service.create('c1', { serviceId: 's1', startsAt: future().toISOString(), patientName: 'John', patientPhone: '1809' }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates appointment and fires WhatsApp message on success', async () => {
      const svc = makeService();
      const appt = makeAppointment();
      prisma.service.findFirst.mockResolvedValue(svc);
      availability.checkSlot.mockResolvedValue({ available: true });
      prisma.patient.upsert.mockResolvedValue({ id: 'p1', name: 'John', phone: '1809' });
      prisma.appointment.create.mockResolvedValue(appt);

      const result = await service.create('c1', {
        serviceId: 's1',
        startsAt: future().toISOString(),
        patientName: 'John',
        patientPhone: '1809',
      });

      expect(result).toBe(appt);
      expect(prisma.appointment.create).toHaveBeenCalledTimes(1);
      // fire-and-forget — just ensure it was called
      await Promise.resolve(); // flush microtasks
      expect(whatsappMessages.sendCreatedBySecretary).toHaveBeenCalledWith('c1', appt);
    });

    it('uses dto.price over service.price when provided', async () => {
      const svc = makeService({ price: 1500 });
      prisma.service.findFirst.mockResolvedValue(svc);
      availability.checkSlot.mockResolvedValue({ available: true });
      prisma.patient.upsert.mockResolvedValue({ id: 'p1' });
      prisma.appointment.create.mockResolvedValue(makeAppointment({ price: 2000 }));

      await service.create('c1', {
        serviceId: 's1',
        startsAt: future().toISOString(),
        patientName: 'John',
        patientPhone: '1809',
        price: 2000,
      });

      const createArgs = prisma.appointment.create.mock.calls[0][0];
      expect(createArgs.data.price).toBe(2000);
    });

    it('falls back to service.price when dto.price is not provided', async () => {
      const svc = makeService({ price: 1500 });
      prisma.service.findFirst.mockResolvedValue(svc);
      availability.checkSlot.mockResolvedValue({ available: true });
      prisma.patient.upsert.mockResolvedValue({ id: 'p1' });
      prisma.appointment.create.mockResolvedValue(makeAppointment());

      await service.create('c1', {
        serviceId: 's1',
        startsAt: future().toISOString(),
        patientName: 'John',
        patientPhone: '1809',
      });

      const createArgs = prisma.appointment.create.mock.calls[0][0];
      expect(createArgs.data.price).toBe(1500);
    });

    it('sets status to PENDING and createdBy to SECRETARY', async () => {
      prisma.service.findFirst.mockResolvedValue(makeService());
      availability.checkSlot.mockResolvedValue({ available: true });
      prisma.patient.upsert.mockResolvedValue({ id: 'p1' });
      prisma.appointment.create.mockResolvedValue(makeAppointment());

      await service.create('c1', { serviceId: 's1', startsAt: future().toISOString(), patientName: 'J', patientPhone: '1809' });

      const createArgs = prisma.appointment.create.mock.calls[0][0];
      expect(createArgs.data.status).toBe('PENDING');
      expect(createArgs.data.createdBy).toBe('SECRETARY');
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('throws NotFoundException when appointment does not exist', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);
      await expect(service.update('c1', 'appt1', {})).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when appointment is CANCELLED', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ status: 'CANCELLED' }));
      await expect(service.update('c1', 'appt1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when appointment is COMPLETED', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ status: 'COMPLETED' }));
      await expect(service.update('c1', 'appt1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when new serviceId does not exist', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment());
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(service.update('c1', 'appt1', { serviceId: 'nonexistent' })).rejects.toThrow(NotFoundException);
    });

    it('re-checks availability when startsAt changes', async () => {
      const appt = makeAppointment();
      prisma.appointment.findFirst.mockResolvedValue(appt);
      availability.checkSlot.mockResolvedValue({ available: true });
      prisma.patient.update.mockResolvedValue({});
      prisma.appointment.update.mockResolvedValue(makeAppointment());

      const newStartsAt = future(4 * 3600_000).toISOString();
      await service.update('c1', 'appt1', { startsAt: newStartsAt });

      expect(availability.checkSlot).toHaveBeenCalledWith('c1', expect.any(Date), expect.any(Date), 'appt1');
    });

    it('re-checks availability when service changes (different duration)', async () => {
      const appt = makeAppointment();
      prisma.appointment.findFirst.mockResolvedValue(appt);
      prisma.service.findFirst.mockResolvedValue(makeService({ id: 's2', durationMinutes: 60 }));
      availability.checkSlot.mockResolvedValue({ available: true });
      prisma.appointment.update.mockResolvedValue(makeAppointment());

      await service.update('c1', 'appt1', { serviceId: 's2' });

      // endsAt changed because duration changed → slot changed
      expect(availability.checkSlot).toHaveBeenCalled();
    });

    it('does NOT re-check availability when nothing about the slot changes', async () => {
      const appt = makeAppointment();
      prisma.appointment.findFirst.mockResolvedValue(appt);
      prisma.appointment.update.mockResolvedValue(appt);

      await service.update('c1', 'appt1', { patientName: 'New Name' });

      expect(availability.checkSlot).not.toHaveBeenCalled();
    });

    it('throws ConflictException when new slot is not available', async () => {
      const appt = makeAppointment();
      prisma.appointment.findFirst.mockResolvedValue(appt);
      availability.checkSlot.mockResolvedValue({ available: false, reason: 'Booked' });

      await expect(service.update('c1', 'appt1', { startsAt: future(5 * 3600_000).toISOString() })).rejects.toThrow(ConflictException);
    });

    it('resets CONFIRMED → PENDING when startsAt changes', async () => {
      const appt = makeAppointment({ status: 'CONFIRMED' });
      prisma.appointment.findFirst.mockResolvedValue(appt);
      availability.checkSlot.mockResolvedValue({ available: true });
      prisma.appointment.update.mockResolvedValue({ ...appt, status: 'PENDING' });

      await service.update('c1', 'appt1', { startsAt: future(5 * 3600_000).toISOString() });

      const updateArgs = prisma.appointment.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('PENDING');
    });

    it('keeps CONFIRMED status when only non-datetime fields change', async () => {
      const appt = makeAppointment({ status: 'CONFIRMED' });
      prisma.appointment.findFirst.mockResolvedValue(appt);
      prisma.appointment.update.mockResolvedValue(appt);

      await service.update('c1', 'appt1', { price: 2000 });

      const updateArgs = prisma.appointment.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('CONFIRMED');
    });

    it('fires WhatsApp updated message on success', async () => {
      const appt = makeAppointment();
      prisma.appointment.findFirst.mockResolvedValue(appt);
      prisma.appointment.update.mockResolvedValue(appt);

      await service.update('c1', 'appt1', { price: 2000 });

      await Promise.resolve();
      expect(whatsappMessages.sendUpdatedBySecretary).toHaveBeenCalled();
    });
  });

  // ── cancel ─────────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('throws NotFoundException when appointment does not exist', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);
      await expect(service.cancel('c1', 'appt1', {})).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when appointment is already CANCELLED', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ status: 'CANCELLED' }));
      await expect(service.cancel('c1', 'appt1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when appointment is COMPLETED', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ status: 'COMPLETED' }));
      await expect(service.cancel('c1', 'appt1', {})).rejects.toThrow(BadRequestException);
    });

    it('cancels PENDING appointment and sets cancelledBy to SECRETARY', async () => {
      const appt = makeAppointment({ status: 'PENDING' });
      prisma.appointment.findFirst.mockResolvedValue(appt);
      prisma.appointment.update.mockResolvedValue({ ...appt, status: 'CANCELLED', cancelledBy: 'SECRETARY' });

      await service.cancel('c1', 'appt1', { reason: 'Patient request' });

      const updateArgs = prisma.appointment.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('CANCELLED');
      expect(updateArgs.data.cancelledBy).toBe('SECRETARY');
      expect(updateArgs.data.cancelReason).toBe('Patient request');
    });

    it('cancels CONFIRMED appointment', async () => {
      const appt = makeAppointment({ status: 'CONFIRMED' });
      prisma.appointment.findFirst.mockResolvedValue(appt);
      prisma.appointment.update.mockResolvedValue({ ...appt, status: 'CANCELLED' });

      await service.cancel('c1', 'appt1', {});

      expect(prisma.appointment.update).toHaveBeenCalledTimes(1);
    });

    it('fires WhatsApp cancelled message on success', async () => {
      const appt = makeAppointment();
      prisma.appointment.findFirst.mockResolvedValue(appt);
      const cancelled = { ...appt, status: 'CANCELLED' };
      prisma.appointment.update.mockResolvedValue(cancelled);

      await service.cancel('c1', 'appt1', {});

      await Promise.resolve();
      expect(whatsappMessages.sendCancelledBySecretary).toHaveBeenCalledWith('c1', cancelled);
    });
  });

  // ── markResult ─────────────────────────────────────────────────────────────

  describe('markResult', () => {
    it('throws NotFoundException when appointment does not exist', async () => {
      prisma.appointment.findFirst.mockResolvedValue(null);
      await expect(service.markResult('c1', 'appt1', { status: 'COMPLETED' })).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when appointment has not started yet', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ startsAt: future(2 * 3600_000) }));
      await expect(service.markResult('c1', 'appt1', { status: 'COMPLETED' })).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when appointment is CANCELLED', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ startsAt: past(), status: 'CANCELLED' }));
      await expect(service.markResult('c1', 'appt1', { status: 'COMPLETED' })).rejects.toThrow(BadRequestException);
    });

    it('marks PENDING appointment as COMPLETED', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ startsAt: past(), status: 'PENDING' }));
      prisma.appointment.update.mockResolvedValue(makeAppointment({ status: 'COMPLETED' }));

      await service.markResult('c1', 'appt1', { status: 'COMPLETED' });

      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'COMPLETED' } }),
      );
    });

    it('marks CONFIRMED appointment as NO_SHOW', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ startsAt: past(), status: 'CONFIRMED' }));
      prisma.appointment.update.mockResolvedValue(makeAppointment({ status: 'NO_SHOW' }));

      await service.markResult('c1', 'appt1', { status: 'NO_SHOW' });

      const updateArgs = prisma.appointment.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('NO_SHOW');
    });

    it('allows correcting COMPLETED → NO_SHOW', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ startsAt: past(), status: 'COMPLETED' }));
      prisma.appointment.update.mockResolvedValue(makeAppointment({ status: 'NO_SHOW' }));

      await expect(service.markResult('c1', 'appt1', { status: 'NO_SHOW' })).resolves.not.toThrow();
    });

    it('allows correcting NO_SHOW → COMPLETED', async () => {
      prisma.appointment.findFirst.mockResolvedValue(makeAppointment({ startsAt: past(), status: 'NO_SHOW' }));
      prisma.appointment.update.mockResolvedValue(makeAppointment({ status: 'COMPLETED' }));

      await expect(service.markResult('c1', 'appt1', { status: 'COMPLETED' })).resolves.not.toThrow();
    });
  });
});
