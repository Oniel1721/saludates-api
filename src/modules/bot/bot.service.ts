import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConversationFlow, MessageSender, MessageType, NotificationType, Prisma } from '@prisma/client';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { IntentService, BotIntent, ClassifyParams } from '@/modules/bot/intent.service';
import type { IncomingMessage } from '@/lib/wasender';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecentMessage {
  sender: string;
  text: string;
}

/** Minimal conversation context passed to flow handlers. */
export interface FlowConversation {
  id: string;
  flow: ConversationFlow;
  flowState: Prisma.JsonValue;
}

/** Minimal patient context passed to flow handlers. */
export interface FlowPatient {
  id: string;
  name: string;
  phone: string;
}

/**
 * Contract that each flow handler must implement.
 * Registered via BotService.registerFlowHandler() in each flow's onModuleInit.
 */
export interface FlowHandler {
  /** Called when the patient's intent triggers this flow for the first time. */
  start(clinicId: string, conversation: FlowConversation, patient: FlowPatient): Promise<void>;
  /** Called on every subsequent message while the conversation is in this flow. */
  handleStep(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
  ): Promise<void>;
}

// ─── BotService ───────────────────────────────────────────────────────────────

/**
 * Core bot orchestrator (T-20).
 *
 * Pipeline for every incoming WhatsApp message:
 *   1. Extract patient phone from message key
 *   2. Find or create patient in DB
 *   3. Find or create conversation
 *   4. Persist the message
 *   5a. fromMe=true  → secretary reply → trigger ESCALATION_SECRETARY_REPLY notification
 *   5b. fromMe=false → patient message → check flow → route
 *
 * Escalation (T-28):
 *   - Low-confidence intent or ESCALATE → set flow=ESCALATED, notify secretary
 *   - While ESCALATED → bot is silenced; only persists patient messages
 *   - Secretary replies → ESCALATION_SECRETARY_REPLY notification
 *   - Secretary resolves via API → flow resets to OUT_OF_FLOW (see ConversationsService.resolve)
 *
 * Individual flows (T-21..T-27) will override `dispatchFlow` for their intent.
 * Until then, Claude generates a contextual response.
 */
@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);
  private readonly flowHandlers = new Map<ConversationFlow, FlowHandler>();

  /**
   * Flow modules call this in their onModuleInit to register themselves.
   * When a conversation enters that flow, BotService delegates to the handler.
   */
  registerFlowHandler(flow: ConversationFlow, handler: FlowHandler): void {
    this.flowHandlers.set(flow, handler);
    this.logger.log(`Flow handler registered for: ${flow}`);
  }

  /**
   * Transitions a conversation to a new flow and calls the handler's start().
   * Used by flows that need to chain into another flow (e.g. CONFIRMING → RESCHEDULING).
   */
  async transitionToFlow(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    flow: ConversationFlow,
    flowState: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { flow, flowState: flowState as Prisma.InputJsonValue },
    });
    const handler = this.flowHandlers.get(flow);
    if (handler) {
      await handler.start(
        clinicId,
        { ...conversation, flow, flowState: flowState as Prisma.JsonValue },
        patient,
      );
    }
  }

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsAppService,
    private notifications: NotificationsService,
    private intent: IntentService,
  ) {}

  onModuleInit() {
    this.whatsapp.registerMessageHandler(this.handleMessage.bind(this));
  }

  // ── Entry point ─────────────────────────────────────────────────────────────

  async handleMessage(clinicId: string, message: IncomingMessage): Promise<void> {
    try {
      const { fromMe, remoteJid } = message.key;

      // Extract phone from JID (e.g. "18091234567@s.whatsapp.net" → "18091234567")
      const phone = remoteJid.replace(/@.*/, '');

      // Skip status broadcasts and group messages
      if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) return;

      // 1. Resolve patient
      const patient = await this.prisma.patient.upsert({
        where: { clinicId_phone: { clinicId, phone } },
        create: { clinicId, phone, name: phone }, // placeholder name until collected
        update: {},
      });

      // 2. Get or create conversation (most recent one for this patient in the clinic)
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

  /**
   * When the secretary sends a message from WhatsApp (fromMe=true):
   * - If the conversation is escalated → notify the secretary that they replied
   *   and ask if the escalation was resolved (ESCALATION_SECRETARY_REPLY).
   * - Otherwise → ignore (bot's own outgoing messages).
   */
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

    // If bot is silenced (escalated) — don't respond
    if (conversation.flow === ConversationFlow.ESCALATED) return;

    // Collect patient name if this is a new patient (placeholder name = phone number)
    if (patient.name === patient.phone) {
      await this.collectPatientName(clinicId, conversation, patient, text);
      return;
    }

    // If there's an active flow, delegate to its registered handler
    if (conversation.flow !== ConversationFlow.OUT_OF_FLOW) {
      const handler = this.flowHandlers.get(conversation.flow);
      if (handler) {
        await handler.handleStep(clinicId, conversation, patient, text);
        return;
      }
      // No handler registered yet — Claude fallback
      const clinicName = (
        await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true } })
      )?.name ?? 'el consultorio';
      const recentMessages = await this.getRecentMessages(conversation.id);
      const response = await this.intent.generateResponse({
        clinicName, patientName: patient.name, patientMessage: text,
        currentFlow: conversation.flow, recentMessages, intent: 'ESCALATE',
      });
      await this.whatsapp.sendText(clinicId, patient.phone, response);
      return;
    }

    // OUT_OF_FLOW: classify intent and dispatch
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true },
    });
    const clinicName = clinic?.name ?? 'el consultorio';

    const recentMessages = await this.getRecentMessages(conversation.id);

    const classifyParams: ClassifyParams = {
      clinicName,
      patientName: patient.name,
      patientMessage: text,
      currentFlow: conversation.flow,
      recentMessages,
    };

    const { intent, confidence } = await this.intent.classifyIntent(classifyParams);

    if (confidence === 'low' || intent === 'ESCALATE') {
      await this.escalate(clinicId, conversation, patient);
      return;
    }

    await this.dispatchIntent(clinicId, conversation, patient, intent, classifyParams);
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
      // First interaction — ask for name
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

    // Patient replied with their name
    const name = text.slice(0, 100).trim(); // reasonable max length
    await this.prisma.patient.update({
      where: { id: patient.id },
      data: { name },
    });
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

  // ── Intent dispatch ──────────────────────────────────────────────────────────

  /**
   * Routes a classified intent to the appropriate handler.
   * Intents without a dedicated flow (T-21..T-26) fall back to Claude response generation.
   * Each flow module will override the relevant case when implemented.
   */
  protected async dispatchIntent(
    clinicId: string,
    conversation: { id: string; flow: ConversationFlow; flowState: Prisma.JsonValue },
    patient: { id: string; name: string; phone: string },
    intent: BotIntent,
    classifyParams: ClassifyParams,
  ): Promise<void> {
    switch (intent) {
      case 'GREETING':
        await this.whatsapp.sendText(
          clinicId,
          patient.phone,
          `Hola ${patient.name}, ¿en qué le puedo ayudar?`,
        );
        break;

      case 'UNRELATED':
        await this.whatsapp.sendText(
          clinicId,
          patient.phone,
          `Disculpe, solo puedo ayudarle con temas relacionados con ${classifyParams.clinicName}, como citas, servicios y disponibilidad. ¿En qué le puedo ayudar?`,
        );
        break;

      case 'QUERY_APPOINTMENTS':
        await this.handleQueryAppointments(clinicId, conversation, patient);
        break;

      case 'QUERY_SERVICES':
        await this.handleQueryServices(clinicId, conversation, patient);
        break;

      // Flows T-21..T-26: update conversation flow + generate contextual response via Claude.
      // These will be replaced by dedicated flow handlers in subsequent tasks.
      case 'CREATE_APPOINTMENT': {
        const handler = this.flowHandlers.get(ConversationFlow.CREATING_APPOINTMENT);
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { flow: ConversationFlow.CREATING_APPOINTMENT, flowState: Prisma.JsonNull },
        });
        if (handler) {
          await handler.start(clinicId, conversation, patient);
        } else {
          await this.respondWithClaude(clinicId, patient, classifyParams, 'CREATE_APPOINTMENT');
        }
        break;
      }

      case 'CANCEL_APPOINTMENT': {
        const handler = this.flowHandlers.get(ConversationFlow.CANCELLING);
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { flow: ConversationFlow.CANCELLING, flowState: Prisma.JsonNull },
        });
        if (handler) {
          await handler.start(clinicId, conversation, patient);
        } else {
          await this.respondWithClaude(clinicId, patient, classifyParams, 'CANCEL_APPOINTMENT');
        }
        break;
      }

      case 'RESCHEDULE_APPOINTMENT': {
        const handler = this.flowHandlers.get(ConversationFlow.RESCHEDULING);
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { flow: ConversationFlow.RESCHEDULING, flowState: Prisma.JsonNull },
        });
        if (handler) {
          await handler.start(clinicId, conversation, patient);
        } else {
          await this.respondWithClaude(clinicId, patient, classifyParams, 'RESCHEDULE_APPOINTMENT');
        }
        break;
      }

      case 'CONFIRM':
      case 'DENY':
        // Flow-specific responses — use Claude for now
        await this.respondWithClaude(clinicId, patient, classifyParams, intent);
        break;

      default:
        await this.escalate(clinicId, conversation, patient);
    }
  }

  // ── QUERY_APPOINTMENTS — T-25 ─────────────────────────────────────────────

  private async handleQueryAppointments(
    clinicId: string,
    conversation: { id: string },
    patient: { id: string; phone: string },
  ): Promise<void> {
    const appointments = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        patientId: patient.id,
        status: { in: ['PENDING', 'CONFIRMED'] },
        startsAt: { gte: new Date() },
      },
      include: { service: true },
      orderBy: { startsAt: 'asc' },
    });

    let text: string;

    if (appointments.length === 0) {
      text = 'No tiene citas pendientes en este momento. ¿Desea agendar una?';
    } else if (appointments.length === 1) {
      const a = appointments[0];
      const estado = a.status === 'CONFIRMED' ? 'Confirmada' : 'Pendiente';
      text = [
        'Tiene la siguiente cita pendiente:',
        '',
        `Servicio: ${a.service.name}`,
        `Fecha: ${this.formatDate(a.startsAt)}`,
        `Hora: ${this.formatTime(a.startsAt)}`,
        `Precio: RD$${a.price}`,
        `Estado: ${estado}`,
      ].join('\n');
    } else {
      const lines = appointments.map(
        (a, i) =>
          `${i + 1}. ${a.service.name} — ${this.formatDate(a.startsAt)} a las ${this.formatTime(a.startsAt)} — ${a.status === 'CONFIRMED' ? 'Confirmada' : 'Pendiente'}`,
      );
      text = `Tiene las siguientes citas pendientes:\n\n${lines.join('\n')}`;
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { flow: ConversationFlow.OUT_OF_FLOW },
    });

    await this.whatsapp.sendText(clinicId, patient.phone, text);
  }

  // ── QUERY_SERVICES — T-26 ─────────────────────────────────────────────────

  private async handleQueryServices(
    clinicId: string,
    conversation: { id: string },
    patient: { phone: string },
  ): Promise<void> {
    const services = await this.prisma.service.findMany({
      where: { clinicId, archivedAt: null },
      orderBy: { name: 'asc' },
    });

    let text: string;

    if (services.length === 0) {
      text =
        'En este momento no tenemos servicios disponibles. Por favor contáctenos directamente.';
    } else {
      const lines = services.map(
        (s, i) => `${i + 1}. ${s.name} — RD$${s.price} (${s.durationMinutes} min)`,
      );
      text = `Estos son nuestros servicios disponibles:\n\n${lines.join('\n')}\n\n¿Le interesa alguno en particular?`;
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { flow: ConversationFlow.OUT_OF_FLOW },
    });

    await this.whatsapp.sendText(clinicId, patient.phone, text);
  }

  // ── Flow stubs (T-21..T-24) ──────────────────────────────────────────────

  /**
   * Starts a multi-step flow: updates the conversation flow state and
   * generates an initial response via Claude.
   * Will be replaced by dedicated flow handlers in T-21..T-24.
   */
  private async startFlow(
    clinicId: string,
    conversation: { id: string },
    patient: { phone: string },
    flow: ConversationFlow,
    classifyParams: ClassifyParams,
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { flow, flowState: Prisma.JsonNull },
    });

    const response = await this.intent.generateResponse({
      ...classifyParams,
      intent: this.flowToIntent(flow),
    });

    await this.whatsapp.sendText(clinicId, patient.phone, response);
  }

  private async respondWithClaude(
    clinicId: string,
    patient: { phone: string },
    classifyParams: ClassifyParams,
    intent: BotIntent,
  ): Promise<void> {
    const response = await this.intent.generateResponse({ ...classifyParams, intent });
    await this.whatsapp.sendText(clinicId, patient.phone, response);
  }

  // ── Escalation — T-28 ────────────────────────────────────────────────────

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
    // Bot goes silent — no response to the patient
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

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

  private async getRecentMessages(conversationId: string): Promise<RecentMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: { conversationId, type: MessageType.TEXT },
      orderBy: { sentAt: 'desc' },
      take: 8,
      select: { sender: true, text: true },
    });

    return messages
      .reverse()
      .filter((m) => m.text)
      .map((m) => ({
        sender: m.sender === MessageSender.PATIENT ? 'Paciente' : 'Consultorio',
        text: m.text!,
      }));
  }

  private formatDate(date: Date): string {
    return format(date, "EEEE d 'de' MMMM", { locale: es });
  }

  private formatTime(date: Date): string {
    return format(date, 'h:mm a', { locale: es }).toUpperCase();
  }

  private flowToIntent(flow: ConversationFlow): BotIntent {
    switch (flow) {
      case ConversationFlow.CREATING_APPOINTMENT:
        return 'CREATE_APPOINTMENT';
      case ConversationFlow.CANCELLING:
        return 'CANCEL_APPOINTMENT';
      case ConversationFlow.RESCHEDULING:
        return 'RESCHEDULE_APPOINTMENT';
      default:
        return 'ESCALATE';
    }
  }
}
