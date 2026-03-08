import { ConversationFlow } from '@prisma/client';
import { ConfirmingFlow } from '@/modules/bot/flows/confirming.flow';

describe('ConfirmingFlow', () => {
  let flow: ConfirmingFlow;
  let prisma: Record<string, jest.Mock>;
  let whatsapp: { sendText: jest.Mock };
  let intent: { callJson: jest.Mock };
  let bot: { registerFlowHandler: jest.Mock; escalate: jest.Mock; transitionToFlow: jest.Mock };

  const future = (ms: number) => new Date(Date.now() + ms);
  const h = (n: number) => n * 60 * 60 * 1000;

  const makeConversation = (overrides = {}) => ({
    id: 'conv1',
    flow: ConversationFlow.CONFIRMING,
    flowState: { appointmentId: 'appt1' },
    ...overrides,
  });

  const makePatient = (overrides = {}) => ({
    id: 'p1',
    name: 'John',
    phone: '18091234567',
    ...overrides,
  });

  const makeAppointment = (overrides = {}) => ({
    id: 'appt1',
    clinicId: 'c1',
    status: 'PENDING',
    price: 1500,
    startsAt: future(h(2)),
    patient: { id: 'p1', name: 'John', phone: '18091234567' },
    service: { name: 'Consulta', prerequisites: null },
    clinic: { name: 'Clinica DR' },
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      appointment: { findUnique: jest.fn(), update: jest.fn() },
      conversation: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    whatsapp = { sendText: jest.fn().mockResolvedValue(undefined) };
    intent = { callJson: jest.fn() };
    bot = {
      registerFlowHandler: jest.fn(),
      escalate: jest.fn().mockResolvedValue(undefined),
      transitionToFlow: jest.fn().mockResolvedValue(undefined),
    };
    flow = new ConfirmingFlow(prisma as never, whatsapp as never, intent as never, bot as never);
  });

  // ── sendReminder ───────────────────────────────────────────────────────────

  describe('sendReminder', () => {
    it('does nothing when appointment does not exist', async () => {
      prisma.appointment.findUnique.mockResolvedValue(null);
      await flow.sendReminder('c1', 'appt1');
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('does nothing when appointment is not PENDING', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment({ status: 'CONFIRMED' }));
      await flow.sendReminder('c1', 'appt1');
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('creates a new conversation when none exists', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      prisma.conversation.findFirst.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-new' });
      prisma.conversation.update.mockResolvedValue({});
      prisma.appointment.update.mockResolvedValue({});

      await flow.sendReminder('c1', 'appt1');

      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clinicId: 'c1', patientId: 'p1' }) }),
      );
    });

    it('reuses existing conversation and sets flow to CONFIRMING', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.conversation.update.mockResolvedValue({});
      prisma.appointment.update.mockResolvedValue({});

      await flow.sendReminder('c1', 'appt1');

      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv1' },
          data: expect.objectContaining({
            flow: ConversationFlow.CONFIRMING,
            appointmentId: 'appt1',
          }),
        }),
      );
    });

    it('marks reminderSentAt on the appointment', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.conversation.update.mockResolvedValue({});
      prisma.appointment.update.mockResolvedValue({});

      await flow.sendReminder('c1', 'appt1');

      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { reminderSentAt: expect.any(Date) } }),
      );
    });

    it('sends MSG-04 WhatsApp message with appointment details', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.conversation.update.mockResolvedValue({});
      prisma.appointment.update.mockResolvedValue({});

      await flow.sendReminder('c1', 'appt1');

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        'c1',
        '18091234567',
        expect.stringContaining('¿Confirma su asistencia?'),
      );
      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('John');
      expect(msg).toContain('Clinica DR');
      expect(msg).toContain('Consulta');
      expect(msg).toContain('RD$1500');
    });

    it('includes prerequisites in MSG-04 when service has them', async () => {
      prisma.appointment.findUnique.mockResolvedValue(
        makeAppointment({ service: { name: 'Consulta', prerequisites: 'Ayunas 8h' } }),
      );
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.conversation.update.mockResolvedValue({});
      prisma.appointment.update.mockResolvedValue({});

      await flow.sendReminder('c1', 'appt1');

      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('Ayunas 8h');
    });

    it('omits prerequisites line when service has none', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.conversation.update.mockResolvedValue({});
      prisma.appointment.update.mockResolvedValue({});

      await flow.sendReminder('c1', 'appt1');

      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).not.toContain('Recuerde:');
    });
  });

  // ── handleStep ─────────────────────────────────────────────────────────────

  describe('handleStep', () => {
    it('resets flow when flowState has no appointmentId', async () => {
      prisma.conversation.update.mockResolvedValue({});
      const conv = makeConversation({ flowState: {} });

      await flow.handleStep('c1', conv, makePatient(), 'sí');

      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ flow: ConversationFlow.OUT_OF_FLOW }) }),
      );
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('resets and asks for help when appointment is no longer PENDING', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment({ status: 'CONFIRMED' }));
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', makeConversation(), makePatient(), 'sí');

      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ flow: ConversationFlow.OUT_OF_FLOW }) }),
      );
      expect(whatsapp.sendText).toHaveBeenCalledWith('c1', '18091234567', expect.any(String));
    });

    it('confirms appointment and sends MSG-05 when patient says confirm', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockResolvedValue({ action: 'confirm' });
      prisma.appointment.update.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', makeConversation(), makePatient(), 'sí confirmo');

      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CONFIRMED' } }),
      );
      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('le esperamos');
    });

    it('cancels appointment with PATIENT cancelledBy and sends MSG-06 when patient cancels', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockResolvedValue({ action: 'cancel' });
      prisma.appointment.update.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', makeConversation(), makePatient(), 'no puedo ir');

      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CANCELLED', cancelledBy: 'PATIENT' }),
        }),
      );
      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('cancelada');
    });

    it('sets cancelledAt timestamp when patient cancels', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockResolvedValue({ action: 'cancel' });
      prisma.appointment.update.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', makeConversation(), makePatient(), 'no voy a poder');

      const updateArgs = prisma.appointment.update.mock.calls[0][0];
      expect(updateArgs.data.cancelledAt).toBeInstanceOf(Date);
    });

    it('transitions to RESCHEDULING flow when patient wants to reschedule', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockResolvedValue({ action: 'reschedule' });

      await flow.handleStep('c1', makeConversation(), makePatient(), 'quiero cambiar la fecha');

      expect(bot.transitionToFlow).toHaveBeenCalledWith(
        'c1',
        expect.any(Object),
        expect.any(Object),
        ConversationFlow.RESCHEDULING,
        { appointmentId: 'appt1' },
      );
    });

    it('escalates when patient response is other/unclear', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockResolvedValue({ action: 'other' });

      await flow.handleStep('c1', makeConversation(), makePatient(), 'cuánto cuesta?');

      expect(bot.escalate).toHaveBeenCalledWith('c1', expect.any(Object), expect.any(Object));
    });

    it('escalates when Claude fails to classify', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockRejectedValue(new Error('Claude timeout'));

      await flow.handleStep('c1', makeConversation(), makePatient(), '???');

      expect(bot.escalate).toHaveBeenCalled();
    });
  });
});
