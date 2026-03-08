import { ConversationFlow } from '@prisma/client';
import { CancellingFlow } from '@/modules/bot/flows/cancelling.flow';

describe('CancellingFlow', () => {
  let flow: CancellingFlow;
  let prisma: Record<string, jest.Mock>;
  let whatsapp: { sendText: jest.Mock };
  let intent: { callJson: jest.Mock };
  let bot: { registerFlowHandler: jest.Mock; escalate: jest.Mock };

  const future = (ms: number) => new Date(Date.now() + ms);
  const h = (n: number) => n * 60 * 60 * 1000;

  const makeConversation = (overrides = {}) => ({
    id: 'conv1',
    flow: ConversationFlow.CANCELLING,
    flowState: null,
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
    startsAt: future(h(4)),
    service: { name: 'Consulta' },
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      appointment: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      conversation: { update: jest.fn() },
    };
    whatsapp = { sendText: jest.fn().mockResolvedValue(undefined) };
    intent = { callJson: jest.fn() };
    bot = { registerFlowHandler: jest.fn(), escalate: jest.fn().mockResolvedValue(undefined) };

    flow = new CancellingFlow(prisma as never, whatsapp as never, intent as never, bot as never);
  });

  // ── start ──────────────────────────────────────────────────────────────────

  describe('start', () => {
    it('sends no-appointments message and resets flow when patient has no cancellable appointments', async () => {
      prisma.appointment.findMany.mockResolvedValue([]);
      prisma.conversation.update.mockResolvedValue({});

      await flow.start('c1', makeConversation(), makePatient());

      expect(whatsapp.sendText).toHaveBeenCalledWith(
        'c1',
        '18091234567',
        expect.stringContaining('No tiene citas pendientes'),
      );
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ flow: ConversationFlow.OUT_OF_FLOW }) }),
      );
    });

    it('shows the appointment and asks for confirmation when there is exactly one', async () => {
      prisma.appointment.findMany.mockResolvedValue([makeAppointment()]);
      prisma.conversation.update.mockResolvedValue({});

      await flow.start('c1', makeConversation(), makePatient());

      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('Consulta');
      expect(msg).toContain('¿Confirma que desea cancelarla?');
    });

    it('sets state to confirming_cancellation with correct appointmentId for single appointment', async () => {
      prisma.appointment.findMany.mockResolvedValue([makeAppointment({ id: 'a1' })]);
      prisma.conversation.update.mockResolvedValue({});

      await flow.start('c1', makeConversation(), makePatient());

      const updateArgs = prisma.conversation.update.mock.calls[0][0];
      expect(updateArgs.data.flowState).toEqual({ step: 'confirming_cancellation', appointmentId: 'a1' });
    });

    it('lists all appointments and asks which to cancel when patient has multiple', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ id: 'a1', service: { name: 'Consulta' } }),
        makeAppointment({ id: 'a2', service: { name: 'Revisión' } }),
      ]);
      prisma.conversation.update.mockResolvedValue({});

      await flow.start('c1', makeConversation(), makePatient());

      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('Consulta');
      expect(msg).toContain('Revisión');
      expect(msg).toContain('¿Cuál desea cancelar?');
    });

    it('sets state to selecting_appointment with all appointmentIds for multiple', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ id: 'a1' }),
        makeAppointment({ id: 'a2' }),
      ]);
      prisma.conversation.update.mockResolvedValue({});

      await flow.start('c1', makeConversation(), makePatient());

      const updateArgs = prisma.conversation.update.mock.calls[0][0];
      expect(updateArgs.data.flowState.step).toBe('selecting_appointment');
      expect(updateArgs.data.flowState.appointmentIds).toEqual(['a1', 'a2']);
    });
  });

  // ── handleStep — selecting_appointment ───────────────────────────────────────

  describe('handleStep — selecting_appointment', () => {
    const conv = makeConversation({
      flowState: { step: 'selecting_appointment', appointmentIds: ['a1', 'a2'] },
    });

    it('asks again when Claude cannot identify which appointment', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ id: 'a1' }),
        makeAppointment({ id: 'a2' }),
      ]);
      intent.callJson.mockResolvedValue({ selected: false });
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'no sé');

      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('No entendí');
    });

    it('moves to confirming_cancellation when patient picks a valid appointment', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ id: 'a1' }),
        makeAppointment({ id: 'a2' }),
      ]);
      intent.callJson.mockResolvedValue({ selected: true, appointmentId: 'a1' });
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'la primera');

      const updateArgs = prisma.conversation.update.mock.calls[0][0];
      expect(updateArgs.data.flowState).toEqual({ step: 'confirming_cancellation', appointmentId: 'a1' });
    });

    it('shows the selected appointment in the confirmation message', async () => {
      prisma.appointment.findMany.mockResolvedValue([
        makeAppointment({ id: 'a1', service: { name: 'Consulta' } }),
        makeAppointment({ id: 'a2', service: { name: 'Revisión' } }),
      ]);
      intent.callJson.mockResolvedValue({ selected: true, appointmentId: 'a1' });
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'la primera');

      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('Consulta');
    });
  });

  // ── handleStep — confirming_cancellation ──────────────────────────────────

  describe('handleStep — confirming_cancellation', () => {
    const conv = makeConversation({
      flowState: { step: 'confirming_cancellation', appointmentId: 'appt1' },
    });

    it('asks again when Claude cannot parse confirm/deny', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockRejectedValue(new Error('fail'));
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), '...');

      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('Por favor responda sí o no');
    });

    it('cancels the appointment and sends confirmation when patient confirms', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment({ status: 'PENDING' }));
      intent.callJson.mockResolvedValue({ action: 'confirm' });
      prisma.appointment.update.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'sí cancela');

      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CANCELLED', cancelledBy: 'PATIENT' }),
        }),
      );
      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('cancelada');
    });

    it('keeps the appointment and sends keep message when patient denies', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockResolvedValue({ action: 'deny' });
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'no, mantenla');

      expect(prisma.appointment.update).not.toHaveBeenCalled();
      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('se mantiene');
    });

    it('handles appointment already processed (not PENDING/CONFIRMED)', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment({ status: 'CANCELLED' }));
      intent.callJson.mockResolvedValue({ action: 'confirm' });
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'sí');

      // Should NOT call appointment.update to cancel again
      expect(prisma.appointment.update).not.toHaveBeenCalled();
      const msg = whatsapp.sendText.mock.calls[0][2] as string;
      expect(msg).toContain('ya fue procesada');
    });

    it('resets flow to OUT_OF_FLOW after successful cancellation', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment({ status: 'PENDING' }));
      intent.callJson.mockResolvedValue({ action: 'confirm' });
      prisma.appointment.update.mockResolvedValue({});
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'sí');

      const updateArgs = prisma.conversation.update.mock.calls[0][0];
      expect(updateArgs.data.flow).toBe(ConversationFlow.OUT_OF_FLOW);
    });

    it('resets flow after patient denies', async () => {
      prisma.appointment.findUnique.mockResolvedValue(makeAppointment());
      intent.callJson.mockResolvedValue({ action: 'deny' });
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', conv, makePatient(), 'no');

      const updateArgs = prisma.conversation.update.mock.calls[0][0];
      expect(updateArgs.data.flow).toBe(ConversationFlow.OUT_OF_FLOW);
    });
  });

  // ── handleStep — unexpected state ─────────────────────────────────────────

  describe('handleStep — unexpected/null state', () => {
    it('restarts flow when state is null', async () => {
      prisma.appointment.findMany.mockResolvedValue([]);
      prisma.conversation.update.mockResolvedValue({});

      await flow.handleStep('c1', makeConversation({ flowState: null }), makePatient(), 'hola');

      // start() was called → no appointments → reset message
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        'c1',
        '18091234567',
        expect.stringContaining('No tiene citas'),
      );
    });
  });
});
