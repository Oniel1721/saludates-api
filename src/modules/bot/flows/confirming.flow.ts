import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CancelledBy, ConversationFlow, Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { BotService, FlowConversation, FlowHandler, FlowPatient } from '@/modules/bot/bot.service';
import { IntentService } from '@/modules/bot/intent.service';

// ─── Flow state shape ─────────────────────────────────────────────────────────

type ConfirmingFlowState = {
  appointmentId: string;
};

// ─── ConfirmingFlow ───────────────────────────────────────────────────────────

/**
 * Flow 2 — 24h reminder and patient confirmation (T-22).
 *
 * Triggered by the scheduler (T-30) via sendReminder(), not by patient intent.
 * Handles three patient responses:
 *   - confirm   → status CONFIRMED, MSG-05
 *   - cancel    → status CANCELLED (cancelledBy=PATIENT), MSG-06
 *   - reschedule → transitions to RESCHEDULING flow (T-24)
 *   - other     → escalate
 */
@Injectable()
export class ConfirmingFlow implements FlowHandler, OnModuleInit {
  private readonly logger = new Logger(ConfirmingFlow.name);

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsAppService,
    private intent: IntentService,
    private bot: BotService,
  ) {}

  onModuleInit() {
    this.bot.registerFlowHandler(ConversationFlow.CONFIRMING, this);
  }

  // ── Scheduler entry point ────────────────────────────────────────────────────

  /**
   * Sends MSG-04 (24h reminder) and puts the conversation in CONFIRMING state.
   * Called by the scheduler 24h before a PENDING appointment.
   */
  async sendReminder(clinicId: string, appointmentId: string): Promise<void> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: true,
        service: true,
        clinic: { select: { name: true } },
      },
    });

    if (!appointment || appointment.status !== 'PENDING') return;

    const { patient, service, clinic } = appointment;

    // Get or create conversation for this patient
    let conversation = await this.prisma.conversation.findFirst({
      where: { clinicId, patientId: patient.id },
      orderBy: { updatedAt: 'desc' },
    });

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: { clinicId, patientId: patient.id, flow: ConversationFlow.CONFIRMING },
      });
    }

    // Set flow to CONFIRMING, link appointment, save flowState
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        flow: ConversationFlow.CONFIRMING,
        flowState: { appointmentId } as unknown as Prisma.InputJsonValue,
        appointmentId,
      },
    });

    // Mark reminder as sent on the appointment
    await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { reminderSentAt: new Date() },
    });

    // Build MSG-04
    const lines = [
      `Hola ${patient.name}, le recordamos su cita en ${clinic.name}:`,
      '',
      `Servicio: ${service.name}`,
      `Fecha: ${this.capitalize(this.fmtDate(appointment.startsAt))}`,
      `Hora: ${this.fmtTime(appointment.startsAt)}`,
      `Precio: RD$${appointment.price}`,
    ];
    if (service.prerequisites) {
      lines.push(`Recuerde: ${service.prerequisites}`);
    }
    lines.push('', '¿Confirma su asistencia?');

    await this.whatsapp.sendText(clinicId, patient.phone, lines.join('\n'));
  }

  // ── FlowHandler ──────────────────────────────────────────────────────────────

  /**
   * CONFIRMING is always started by sendReminder(), not by patient intent.
   * If start() is called anyway (e.g. stale flow), re-send the reminder.
   */
  async start(clinicId: string, conversation: FlowConversation, patient: FlowPatient): Promise<void> {
    const state = conversation.flowState as ConfirmingFlowState | null;
    if (state?.appointmentId) {
      await this.sendReminder(clinicId, state.appointmentId);
    }
  }

  async handleStep(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
  ): Promise<void> {
    const state = conversation.flowState as ConfirmingFlowState | null;

    if (!state?.appointmentId) {
      await this.resetFlow(conversation.id);
      return;
    }

    const appointment = await this.prisma.appointment.findUnique({
      where: { id: state.appointmentId },
      include: { service: { select: { name: true } } },
    });

    if (!appointment || appointment.status !== 'PENDING') {
      // Appointment no longer pending — reset and let patient continue normally
      await this.resetFlow(conversation.id);
      await this.whatsapp.sendText(clinicId, patient.phone, '¿En qué le puedo ayudar?');
      return;
    }

    const decision = await this.callClaude<{ action: 'confirm' | 'cancel' | 'reschedule' | 'other' }>(
      `El paciente tiene una cita pendiente de confirmación (servicio: ${appointment.service.name}).

El paciente respondió: "${text}"

¿Qué quiere hacer el paciente? Responde SOLO con JSON válido:
{"action": "confirm"} — confirma su asistencia
{"action": "cancel"} — no puede ir, quiere cancelar
{"action": "reschedule"} — quiere cambiar la fecha/hora
{"action": "other"} — otra cosa o no está claro`,
      60,
    );

    switch (decision?.action ?? 'other') {
      case 'confirm':
        await this.handleConfirm(clinicId, conversation, patient, appointment);
        break;
      case 'cancel':
        await this.handleCancel(clinicId, conversation, patient, appointment);
        break;
      case 'reschedule':
        await this.handleReschedule(clinicId, conversation, patient, state.appointmentId);
        break;
      default:
        await this.bot.escalate(clinicId, conversation, patient);
    }
  }

  // ── Action handlers ───────────────────────────────────────────────────────────

  private async handleConfirm(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    appointment: { id: string; startsAt: Date },
  ): Promise<void> {
    await this.prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CONFIRMED' },
    });
    await this.resetFlow(conversation.id);
    // MSG-05
    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      `Perfecto, le esperamos el ${this.capitalize(this.fmtDate(appointment.startsAt))} a las ${this.fmtTime(appointment.startsAt)}. Cualquier cambio de último momento, no dude en escribirnos.`,
    );
  }

  private async handleCancel(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    appointment: { id: string },
  ): Promise<void> {
    await this.prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        status: 'CANCELLED',
        cancelledBy: CancelledBy.PATIENT,
        cancelledAt: new Date(),
      },
    });
    await this.resetFlow(conversation.id);
    // MSG-06
    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      'Entendido, su cita ha sido cancelada. Cuando desee reagendar, estamos a su disposición.',
    );
  }

  private async handleReschedule(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    appointmentId: string,
  ): Promise<void> {
    // Transition to RESCHEDULING flow (T-24) passing the appointmentId
    await this.bot.transitionToFlow(clinicId, conversation, patient, ConversationFlow.RESCHEDULING, {
      appointmentId,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

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
