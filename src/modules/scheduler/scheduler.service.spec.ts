import { SchedulerService } from '@/modules/scheduler/scheduler.service';
import { NotificationType } from '@prisma/client';

describe('SchedulerService', () => {
  let service: SchedulerService;
  let prisma: Record<string, jest.Mock>;
  let notifications: { create: jest.Mock };
  let confirmingFlow: { sendReminder: jest.Mock };

  const future = (ms: number) => new Date(Date.now() + ms);
  const past = (ms: number) => new Date(Date.now() - ms);
  const h = (n: number) => n * 60 * 60 * 1000;

  const makeAppointment = (overrides = {}) => ({
    id: 'appt1',
    clinicId: 'c1',
    status: 'PENDING',
    startsAt: future(h(2)),
    patient: { name: 'John' },
    service: { name: 'Consulta' },
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      appointment: { findMany: jest.fn() },
      notification: { findMany: jest.fn() },
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    confirmingFlow = { sendReminder: jest.fn().mockResolvedValue(undefined) };

    service = new SchedulerService(prisma as never, notifications as never, confirmingFlow as never);
  });

  // ── sendReminders ──────────────────────────────────────────────────────────

  describe('sendReminders', () => {
    it('does nothing when no appointments need a reminder', async () => {
      prisma.appointment.findMany.mockResolvedValue([]);
      await service.sendReminders();
      expect(confirmingFlow.sendReminder).not.toHaveBeenCalled();
    });

    it('sends a reminder for each PENDING appointment without reminderSentAt in the 24h window', async () => {
      const appointments = [
        { id: 'a1', clinicId: 'c1' },
        { id: 'a2', clinicId: 'c2' },
      ];
      prisma.appointment.findMany.mockResolvedValue(appointments);

      await service.sendReminders();

      expect(confirmingFlow.sendReminder).toHaveBeenCalledTimes(2);
      expect(confirmingFlow.sendReminder).toHaveBeenCalledWith('c1', 'a1');
      expect(confirmingFlow.sendReminder).toHaveBeenCalledWith('c2', 'a2');
    });

    it('queries for PENDING appointments with null reminderSentAt in the 24h window', async () => {
      prisma.appointment.findMany.mockResolvedValue([]);
      await service.sendReminders();

      const query = prisma.appointment.findMany.mock.calls[0][0];
      expect(query.where.status).toBe('PENDING');
      expect(query.where.reminderSentAt).toBeNull();
      expect(query.where.startsAt.gt).toBeInstanceOf(Date);
      expect(query.where.startsAt.lte).toBeInstanceOf(Date);
    });

    it('continues processing remaining appointments if one fails', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        { id: 'a1', clinicId: 'c1' },
        { id: 'a2', clinicId: 'c2' },
      ]);
      confirmingFlow.sendReminder
        .mockRejectedValueOnce(new Error('WA down'))
        .mockResolvedValueOnce(undefined);

      await expect(service.sendReminders()).resolves.not.toThrow();
      expect(confirmingFlow.sendReminder).toHaveBeenCalledTimes(2);
    });
  });

  // ── notifyUnconfirmed ──────────────────────────────────────────────────────

  describe('notifyUnconfirmed', () => {
    it('does nothing when no unconfirmed appointments in 2h window', async () => {
      prisma.appointment.findMany.mockResolvedValue([]);
      await service.notifyUnconfirmed();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('creates UNCONFIRMED_2H notification for new appointments', async () => {
      prisma.appointment.findMany.mockResolvedValue([makeAppointment()]);
      prisma.notification.findMany.mockResolvedValue([]); // none already notified

      await service.notifyUnconfirmed();

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.UNCONFIRMED_2H, clinicId: 'c1', appointmentId: 'appt1' }),
      );
    });

    it('skips appointments that already have an UNCONFIRMED_2H notification', async () => {
      prisma.appointment.findMany.mockResolvedValue([makeAppointment({ id: 'a1' })]);
      prisma.notification.findMany.mockResolvedValue([{ appointmentId: 'a1' }]); // already notified

      await service.notifyUnconfirmed();

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('only notifies appointments without prior notification (mixed batch)', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ id: 'a1' }),
        makeAppointment({ id: 'a2' }),
        makeAppointment({ id: 'a3' }),
      ]);
      // a1 and a3 already notified
      prisma.notification.findMany.mockResolvedValue([
        { appointmentId: 'a1' },
        { appointmentId: 'a3' },
      ]);

      await service.notifyUnconfirmed();

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ appointmentId: 'a2' }),
      );
    });

    it('includes patient name and service name in notification body', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ patient: { name: 'María' }, service: { name: 'Revisión' } }),
      ]);
      prisma.notification.findMany.mockResolvedValue([]);

      await service.notifyUnconfirmed();

      const call = notifications.create.mock.calls[0][0];
      expect(call.body).toContain('María');
      expect(call.body).toContain('Revisión');
    });

    it('continues if one notification fails', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ id: 'a1' }),
        makeAppointment({ id: 'a2' }),
      ]);
      prisma.notification.findMany.mockResolvedValue([]);
      notifications.create
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({});

      await expect(service.notifyUnconfirmed()).resolves.not.toThrow();
      expect(notifications.create).toHaveBeenCalledTimes(2);
    });
  });

  // ── notifyResultNeeded ─────────────────────────────────────────────────────

  describe('notifyResultNeeded', () => {
    const pastAppointment = (overrides = {}) =>
      makeAppointment({ startsAt: past(h(1)), ...overrides });

    it('does nothing when no past appointments need result', async () => {
      prisma.appointment.findMany.mockResolvedValue([]);
      await service.notifyResultNeeded();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('creates RESULT_NEEDED notification for past appointments', async () => {
      prisma.appointment.findMany.mockResolvedValue([pastAppointment()]);
      prisma.notification.findMany.mockResolvedValue([]);

      await service.notifyResultNeeded();

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.RESULT_NEEDED, clinicId: 'c1', appointmentId: 'appt1' }),
      );
    });

    it('skips appointments that already have a RESULT_NEEDED notification', async () => {
      prisma.appointment.findMany.mockResolvedValue([pastAppointment({ id: 'a1' })]);
      prisma.notification.findMany.mockResolvedValue([{ appointmentId: 'a1' }]);

      await service.notifyResultNeeded();

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('handles CONFIRMED past appointments too', async () => {
      prisma.appointment.findMany.mockResolvedValue([pastAppointment({ status: 'CONFIRMED' })]);
      prisma.notification.findMany.mockResolvedValue([]);

      await service.notifyResultNeeded();

      expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates correctly across a mixed batch', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        pastAppointment({ id: 'a1' }),
        pastAppointment({ id: 'a2' }),
        pastAppointment({ id: 'a3' }),
      ]);
      prisma.notification.findMany.mockResolvedValue([{ appointmentId: 'a2' }]);

      await service.notifyResultNeeded();

      expect(notifications.create).toHaveBeenCalledTimes(2);
      const ids = notifications.create.mock.calls.map((c: [{ appointmentId: string }]) => c[0].appointmentId);
      expect(ids).toContain('a1');
      expect(ids).toContain('a3');
      expect(ids).not.toContain('a2');
    });

    it('includes patient name and service name in notification title/body', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        pastAppointment({ patient: { name: 'Carlos' }, service: { name: 'Evaluación' } }),
      ]);
      prisma.notification.findMany.mockResolvedValue([]);

      await service.notifyResultNeeded();

      const call = notifications.create.mock.calls[0][0];
      expect(call.title).toContain('Carlos');
      expect(call.body).toContain('Carlos');
      expect(call.body).toContain('Evaluación');
    });

    it('continues if one notification fails', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        pastAppointment({ id: 'a1' }),
        pastAppointment({ id: 'a2' }),
      ]);
      prisma.notification.findMany.mockResolvedValue([]);
      notifications.create
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({});

      await expect(service.notifyResultNeeded()).resolves.not.toThrow();
    });
  });
});
