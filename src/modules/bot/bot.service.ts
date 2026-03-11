import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConversationFlow, MessageSender, MessageType, NotificationType, Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { AgentService } from '@/modules/bot/agent.service';
import type { IncomingMessage } from '@/lib/wasender';

/**
 * Core bot orchestrator.
 *
 * Pipeline for every incoming WhatsApp message:
 *   1. Extract patient phone from message key
 *   2. Find or create patient in DB
 *   3. Find or create conversation
 *   4. Persist the message
 *   5a. fromMe=true  → secretary reply → ESCALATION_SECRETARY_REPLY notification if escalated
 *   5b. fromMe=false → patient message → collect name → run agent
 *
 * Escalation:
 *   - Agent returns escalated=true → set flow=ESCALATED, notify secretary
 *   - While ESCALATED → bot is silenced
 *   - Secretary resolves via API → flow resets to OUT_OF_FLOW (ConversationsService.resolve)
 */
@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsAppService,
    private notifications: NotificationsService,
    private agent: AgentService,
  ) {}

  onModuleInit() {
    this.whatsapp.registerMessageHandler(this.handleMessage.bind(this));
  }

  // ── Entry point ──────────────────────────────────────────────────────────────

  async handleMessage(clinicId: string, message: IncomingMessage): Promise<void> {
    try {
      const { fromMe, remoteJid } = message.key;

      // Extract phone from JID (e.g. "18091234567@s.whatsapp.net" → "+18091234567")
      const rawPhone = remoteJid.replace(/@.*/, '');
      const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;

      // Skip status broadcasts and group messages
      if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) return;

      // 1. Resolve patient
      const patient = await this.prisma.patient.upsert({
        where: { clinicId_phone: { clinicId, phone } },
        create: { clinicId, phone, name: phone },
        update: {},
      });

      // 2. Get or create conversation
      const conversation = await this.getOrCreateConversation(clinicId, patient.id);

      // 3. Persist message
      await this.saveMessage(conversation.id, fromMe, message);

      // 4. Touch updatedAt
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });

      // 5. Route by sender
      if (fromMe) {
        await this.handleSecretaryMessage(clinicId, conversation, patient);
        return;
      }

      await this.handlePatientMessage(clinicId, conversation, patient, message);
    } catch (err) {
      this.logger.error(`Bot pipeline error for clinic ${clinicId}: ${err}`);
    }
  }

  // ── Secretary message ────────────────────────────────────────────────────────

  private async handleSecretaryMessage(
    clinicId: string,
    conversation: { id: string; flow: ConversationFlow },
    patient: { name: string; phone: string },
  ): Promise<void> {
    if (conversation.flow !== ConversationFlow.ESCALATED) return;

    await this.notifications.create({
      clinicId,
      type: NotificationType.ESCALATION_SECRETARY_REPLY,
      title: `Respondiste a ${patient.name}`,
      body: `Has respondido a ${patient.name}. ¿El escalamiento fue resuelto?`,
      conversationId: conversation.id,
    });
  }

  // ── Patient message ──────────────────────────────────────────────────────────

  private async handlePatientMessage(
    clinicId: string,
    conversation: { id: string; flow: ConversationFlow; flowState: Prisma.JsonValue },
    patient: { id: string; name: string; phone: string },
    message: IncomingMessage,
  ): Promise<void> {
    const text = message.messageBody?.trim() ?? '';

    // Bot is silenced while escalated
    if (conversation.flow === ConversationFlow.ESCALATED) return;

    // Collect name if this is a new patient (placeholder name = phone number)
    if (patient.name === patient.phone) {
      await this.collectPatientName(clinicId, conversation, patient, text);
      return;
    }

    // Clear any legacy flow state from the old state-machine architecture
    if (
      conversation.flow !== ConversationFlow.OUT_OF_FLOW ||
      conversation.flowState !== null
    ) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { flow: ConversationFlow.OUT_OF_FLOW, flowState: Prisma.JsonNull },
      });
    }

    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true },
    });
    const clinicName = clinic?.name ?? 'el consultorio';

    const { reply, escalated } = await this.agent.runAgent({
      clinicName,
      clinicId,
      patient,
      conversationId: conversation.id,
    });

    if (escalated) {
      await this.escalate(clinicId, conversation, patient);
      return;
    }

    if (reply) {
      await this.whatsapp.sendText(clinicId, patient.phone, reply);
    }
  }

  // ── Name collection for new patients ─────────────────────────────────────────

  private async collectPatientName(
    clinicId: string,
    conversation: { id: string; flowState: Prisma.JsonValue },
    patient: { id: string; phone: string },
    text: string,
  ): Promise<void> {
    const state = conversation.flowState as { collectingName?: boolean } | null;

    if (!state?.collectingName) {
      const clinic = await this.prisma.clinic.findUnique({
        where: { id: clinicId },
        select: { name: true },
      });

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { flowState: { collectingName: true } },
      });

      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `Hola, bienvenido a ${clinic?.name ?? 'nuestro consultorio'}. ¿Con quién tengo el gusto?`,
      );
      return;
    }

    const name = text.slice(0, 100).trim();
    await this.prisma.patient.update({ where: { id: patient.id }, data: { name } });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { flowState: Prisma.JsonNull },
    });

    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      `Mucho gusto, ${name}. ¿En qué le puedo ayudar?`,
    );
  }

  // ── Escalation ────────────────────────────────────────────────────────────────

  async escalate(
    clinicId: string,
    conversation: { id: string },
    patient: { name: string; phone: string },
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { flow: ConversationFlow.ESCALATED, flowState: Prisma.JsonNull },
    });

    await this.notifications.create({
      clinicId,
      type: NotificationType.ESCALATION,
      title: `Escalamiento: ${patient.name}`,
      body: `El bot no pudo resolver la consulta de ${patient.name} (${patient.phone}). Se requiere atención manual.`,
      conversationId: conversation.id,
    });

    this.logger.log(`Escalated conversation for patient ${patient.phone} in clinic ${clinicId}`);
  }

  // ── 24h reminder (called by SchedulerService) ─────────────────────────────────

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

    let conversation = await this.prisma.conversation.findFirst({
      where: { clinicId, patientId: patient.id },
      orderBy: { updatedAt: 'desc' },
    });

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: { clinicId, patientId: patient.id, flow: ConversationFlow.OUT_OF_FLOW },
      });
    }

    await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { reminderSentAt: new Date() },
    });

    const lines = [
      `Hola ${patient.name}, le recordamos su cita en ${clinic.name}:`,
      '',
      `Servicio: ${service.name}`,
      `Fecha: ${this.capitalize(this.formatDate(appointment.startsAt))}`,
      `Hora: ${this.formatTime(appointment.startsAt)}`,
      `Precio: RD$${appointment.price}`,
    ];
    if (service.prerequisites) {
      lines.push(`Recuerde: ${service.prerequisites}`);
    }
    lines.push('', '¿Confirma su asistencia? Puede responder sí, no, o indicarnos si desea cambiar la fecha.');

    await this.whatsapp.sendText(clinicId, patient.phone, lines.join('\n'));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private async getOrCreateConversation(clinicId: string, patientId: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: { clinicId, patientId },
      orderBy: { updatedAt: 'desc' },
    });
    if (existing) return existing;
    return this.prisma.conversation.create({
      data: { clinicId, patientId, flow: ConversationFlow.OUT_OF_FLOW },
    });
  }

  private async saveMessage(
    conversationId: string,
    fromMe: boolean,
    message: IncomingMessage,
  ): Promise<void> {
    const sender = fromMe ? MessageSender.SECRETARY : MessageSender.PATIENT;
    const type = this.detectMessageType(message);
    const text = message.messageBody || null;
    const mediaUrl = this.extractMediaUrl(message);

    await this.prisma.message.create({
      data: { conversationId, sender, type, text, mediaUrl, sentAt: new Date() },
    });
  }

  private detectMessageType(message: IncomingMessage): MessageType {
    const m = message.message;
    if (!m) return MessageType.TEXT;
    if (m.imageMessage) return MessageType.IMAGE;
    if (m.videoMessage) return MessageType.VIDEO;
    if (m.audioMessage) return MessageType.AUDIO;
    if (m.documentMessage) return MessageType.DOCUMENT;
    if (m.stickerMessage) return MessageType.STICKER;
    if (m.locationMessage) return MessageType.LOCATION;
    if (m.contactMessage) return MessageType.CONTACT;
    if (m.conversation || message.messageBody) return MessageType.TEXT;
    return MessageType.UNSUPPORTED;
  }

  private extractMediaUrl(message: IncomingMessage): string | null {
    const m = message.message;
    if (!m) return null;
    const media = m.imageMessage ?? m.videoMessage ?? m.audioMessage ?? m.documentMessage;
    return (media as { url?: string } | undefined)?.url ?? null;
  }

  private formatDate(date: Date): string {
    return format(date, "EEEE d 'de' MMMM", { locale: es });
  }

  private formatTime(date: Date): string {
    return format(date, 'h:mm a', { locale: es }).toUpperCase();
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
