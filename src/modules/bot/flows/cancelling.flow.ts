import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CancelledBy, ConversationFlow, Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { BotService, FlowConversation, FlowHandler, FlowPatient } from '@/modules/bot/bot.service';
import { IntentService } from '@/modules/bot/intent.service';

// ─── Flow state shapes ────────────────────────────────────────────────────────

type SelectingAppointmentState = {
  step: 'selecting_appointment';
  appointmentIds: string[];
};

type ConfirmingCancellationState = {
  step: 'confirming_cancellation';
  appointmentId: string;
};

type CancellingState = SelectingAppointmentState | ConfirmingCancellationState;

// ─── CancellingFlow ───────────────────────────────────────────────────────────

/**
 * Flow 3 — Cancel appointment via bot (T-23).
 *
 * Triggered by CANCEL_APPOINTMENT intent in dispatchIntent.
 * Steps:
 *   1. Identify appointment (single → confirm directly; multiple → let patient pick)
 *   2. Confirm cancellation → CANCELLED (cancelledBy=PATIENT)
 */
@Injectable()
export class CancellingFlow implements FlowHandler, OnModuleInit {
  private readonly logger = new Logger(CancellingFlow.name);

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsAppService,
    private intent: IntentService,
    private bot: BotService,
  ) {}

  onModuleInit() {
    this.bot.registerFlowHandler(ConversationFlow.CANCELLING, this);
  }

  // ── FlowHandler ──────────────────────────────────────────────────────────────

  async start(clinicId: string, conversation: FlowConversation, patient: FlowPatient): Promise<void> {
    const appointments = await this.fetchCancellableAppointments(clinicId, patient.id);

    if (appointments.length === 0) {
      await this.resetFlow(conversation.id);
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'No tiene citas pendientes para cancelar. ¿En qué le puedo ayudar?',
      );
      return;
    }

    if (appointments.length === 1) {
      const a = appointments[0];
      await this.updateState(conversation.id, {
        step: 'confirming_cancellation',
        appointmentId: a.id,
      });
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        [
          'Encontré su cita:',
          `${a.service.name} — ${this.capitalize(this.fmtDate(a.startsAt))} a las ${this.fmtTime(a.startsAt)}`,
          '',
          '¿Confirma que desea cancelarla?',
        ].join('\n'),
      );
      return;
    }

    // Multiple appointments — let patient choose
    const lines = appointments.map(
      (a, i) =>
        `${i + 1}. ${a.service.name} — ${this.capitalize(this.fmtDate(a.startsAt))} a las ${this.fmtTime(a.startsAt)}`,
    );
    await this.updateState(conversation.id, {
      step: 'selecting_appointment',
      appointmentIds: appointments.map((a) => a.id),
    });
    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      `Tiene las siguientes citas pendientes:\n\n${lines.join('\n')}\n\n¿Cuál desea cancelar?`,
    );
  }

  async handleStep(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
  ): Promise<void> {
    const state = conversation.flowState as CancellingState | null;

    switch (state?.step) {
      case 'selecting_appointment':
        await this.handleAppointmentSelection(clinicId, conversation, patient, text, state);
        break;
      case 'confirming_cancellation':
        await this.handleConfirmation(clinicId, conversation, patient, text, state);
        break;
      default:
        await this.start(clinicId, conversation, patient);
    }
  }

  // ── Step handlers ────────────────────────────────────────────────────────────

  private async handleAppointmentSelection(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
    state: SelectingAppointmentState,
  ): Promise<void> {
    const appointments = await this.prisma.appointment.findMany({
      where: { id: { in: state.appointmentIds } },
      include: { service: { select: { name: true } } },
      orderBy: { startsAt: 'asc' },
    });

    const appointmentList = appointments
      .map(
        (a, i) =>
          `${i + 1}. ${a.service.name} — ${this.capitalize(this.fmtDate(a.startsAt))} a las ${this.fmtTime(a.startsAt)} (ID: ${a.id})`,
      )
      .join('\n');

    const matched = await this.callClaude<{ selected: boolean; appointmentId?: string }>(
      `El paciente quiere cancelar una cita. Estas son las citas disponibles:
${appointmentList}

El paciente respondió: "${text}"

¿A cuál cita se refiere? Responde SOLO con JSON válido:
{"selected": true, "appointmentId": "..."} o {"selected": false}`,
      80,
    );

    if (!matched?.selected || !matched.appointmentId) {
      const lines = appointments.map(
        (a, i) =>
          `${i + 1}. ${a.service.name} — ${this.capitalize(this.fmtDate(a.startsAt))} a las ${this.fmtTime(a.startsAt)}`,
      );
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `No entendí cuál cita desea cancelar. Por favor indique el número:\n\n${lines.join('\n')}`,
      );
      return;
    }

    const appointment = appointments.find((a) => a.id === matched.appointmentId);
    if (!appointment) {
      await this.start(clinicId, conversation, patient);
      return;
    }

    await this.updateState(conversation.id, {
      step: 'confirming_cancellation',
      appointmentId: appointment.id,
    });

    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      `¿Confirma que desea cancelar su cita de ${appointment.service.name} el ${this.capitalize(this.fmtDate(appointment.startsAt))} a las ${this.fmtTime(appointment.startsAt)}?`,
    );
  }

  private async handleConfirmation(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
    state: ConfirmingCancellationState,
  ): Promise<void> {
    const decision = await this.callClaude<{ action: 'confirm' | 'deny' }>(
      `El paciente debe confirmar si quiere cancelar su cita.
El paciente respondió: "${text}"

¿Está confirmando o rechazando la cancelación? Responde SOLO JSON:
{"action": "confirm"} o {"action": "deny"}`,
      40,
    );

    if (!decision) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        '¿Confirma que desea cancelar la cita? Por favor responda sí o no.',
      );
      return;
    }

    if (decision.action === 'deny') {
      await this.resetFlow(conversation.id);
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'Entendido, su cita se mantiene. ¿Hay algo más en que le pueda ayudar?',
      );
      return;
    }

    // Confirm cancellation
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: state.appointmentId },
    });

    if (!appointment || !['PENDING', 'CONFIRMED'].includes(appointment.status)) {
      await this.resetFlow(conversation.id);
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'No se pudo cancelar la cita (ya fue procesada). ¿En qué le puedo ayudar?',
      );
      return;
    }

    await this.prisma.appointment.update({
      where: { id: state.appointmentId },
      data: {
        status: 'CANCELLED',
        cancelledBy: CancelledBy.PATIENT,
        cancelledAt: new Date(),
      },
    });

    await this.resetFlow(conversation.id);
    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      'Su cita ha sido cancelada. Cuando desee reagendar, estamos a su disposición.',
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private async fetchCancellableAppointments(clinicId: string, patientId: string) {
    return this.prisma.appointment.findMany({
      where: {
        clinicId,
        patientId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { gte: new Date() },
      },
      include: { service: { select: { name: true } } },
      orderBy: { startsAt: 'asc' },
    });
  }

  private async updateState(conversationId: string, state: CancellingState): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { flowState: state as unknown as Prisma.InputJsonValue },
    });
  }

  private async resetFlow(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { flow: ConversationFlow.OUT_OF_FLOW, flowState: Prisma.JsonNull },
    });
  }

  private async callClaude<T>(prompt: string, maxTokens: number): Promise<T | null> {
    try {
      return await this.intent.callJson<T>(prompt, maxTokens);
    } catch (err) {
      this.logger.warn(`Claude call failed: ${err}`);
      return null;
    }
  }

  private fmtDate(date: Date): string {
    return format(date, "EEEE d 'de' MMMM", { locale: es });
  }

  private fmtTime(date: Date): string {
    return format(date, 'h:mm a', { locale: es }).toUpperCase();
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
