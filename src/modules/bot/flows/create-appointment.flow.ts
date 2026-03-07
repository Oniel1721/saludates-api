import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConversationFlow, CreatedBy, Prisma } from '@prisma/client';
import { addDays, differenceInHours, format, isAfter } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { AvailabilityService } from '@/modules/availability/availability.service';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { BotService, FlowConversation, FlowHandler, FlowPatient } from '@/modules/bot/bot.service';
import { IntentService } from '@/modules/bot/intent.service';

// ─── Flow state shape ─────────────────────────────────────────────────────────

type SelectingServiceState = { step: 'selecting_service' };

type SelectingDatetimeState = {
  step: 'selecting_datetime';
  serviceId: string;
  serviceName: string;
  price: number;
  prerequisites: string | null;
  suggestedSlot: string; // ISO datetime shown to patient
};

type BrowsingSlotsState = {
  step: 'browsing_slots';
  serviceId: string;
  serviceName: string;
  price: number;
  prerequisites: string | null;
  shownSlots: string[]; // ISO datetimes shown to patient
};

type ConfirmingState = {
  step: 'confirming';
  serviceId: string;
  serviceName: string;
  startsAt: string; // ISO datetime patient confirmed
  price: number;
  prerequisites: string | null;
};

type CreateAppointmentState =
  | SelectingServiceState
  | SelectingDatetimeState
  | BrowsingSlotsState
  | ConfirmingState;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LOOK_AHEAD_DAYS = 14;
const MAX_SLOTS_SHOWN = 6;

// ─── CreateAppointmentFlow ────────────────────────────────────────────────────

@Injectable()
export class CreateAppointmentFlow implements FlowHandler, OnModuleInit {
  private readonly logger = new Logger(CreateAppointmentFlow.name);

  constructor(
    private prisma: PrismaService,
    private availability: AvailabilityService,
    private whatsapp: WhatsAppService,
    private intent: IntentService,
    private bot: BotService,
  ) {}

  onModuleInit() {
    this.bot.registerFlowHandler(ConversationFlow.CREATING_APPOINTMENT, this);
  }

  // ── FlowHandler ─────────────────────────────────────────────────────────────

  /** Entry point: show services list and set step = selecting_service. */
  async start(clinicId: string, conversation: FlowConversation, patient: FlowPatient): Promise<void> {
    const services = await this.prisma.service.findMany({
      where: { clinicId, archivedAt: null },
      orderBy: { name: 'asc' },
    });

    if (services.length === 0) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'En este momento no tenemos servicios disponibles. Por favor contáctenos directamente.',
      );
      await this.resetFlow(conversation.id);
      return;
    }

    const lines = services.map((s, i) => `${i + 1}. ${s.name} — RD$${s.price} (${s.durationMinutes} min)`);
    const text = `Estos son nuestros servicios disponibles:\n\n${lines.join('\n')}\n\n¿Cuál servicio desea?`;

    await this.updateState(conversation.id, { step: 'selecting_service' });
    await this.whatsapp.sendText(clinicId, patient.phone, text);
  }

  /** Routes each incoming message to the correct step handler. */
  async handleStep(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
  ): Promise<void> {
    const state = conversation.flowState as CreateAppointmentState | null;

    switch (state?.step) {
      case 'selecting_service':
        await this.handleServiceSelection(clinicId, conversation, patient, text);
        break;
      case 'selecting_datetime':
        await this.handleDatetimeDecision(clinicId, conversation, patient, text, state);
        break;
      case 'browsing_slots':
        await this.handleSlotSelection(clinicId, conversation, patient, text, state);
        break;
      case 'confirming':
        await this.handleConfirmation(clinicId, conversation, patient, text, state);
        break;
      default:
        // Unexpected state — restart flow
        await this.start(clinicId, conversation, patient);
    }
  }

  // ── Step 1: Service selection ─────────────────────────────────────────────────

  private async handleServiceSelection(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
  ): Promise<void> {
    const services = await this.prisma.service.findMany({
      where: { clinicId, archivedAt: null },
      orderBy: { name: 'asc' },
    });

    const serviceList = services
      .map((s, i) => `${i + 1}. ${s.name} (ID: ${s.id}, RD$${s.price})`)
      .join('\n');

    const matched = await this.callClaude<{ matched: boolean; serviceId?: string }>(
      `El paciente respondió: "${text}"

Servicios disponibles:
${serviceList}

¿A cuál servicio se refiere el paciente? Responde SOLO con JSON válido:
{"matched": true, "serviceId": "..."} o {"matched": false}`,
      80,
    );

    if (!matched || !matched.matched || !matched.serviceId) {
      const lines = services.map((s, i) => `${i + 1}. ${s.name} — RD$${s.price} (${s.durationMinutes} min)`);
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `No entendí bien cuál servicio desea. Estos son los disponibles:\n\n${lines.join('\n')}\n\n¿Cuál prefiere?`,
      );
      return;
    }

    const service = services.find((s) => s.id === matched.serviceId);
    if (!service) {
      await this.start(clinicId, conversation, patient);
      return;
    }

    // Find next available slot
    const nextSlot = await this.findNextSlot(clinicId, service.id);

    if (!nextSlot) {
      const clinic = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true } });
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `En este momento no tenemos horarios disponibles para ${service.name}. ¿Desea que le contactemos cuando se abra un espacio?`,
      );
      // Escalate for secretary follow-up
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { flow: ConversationFlow.ESCALATED, flowState: Prisma.JsonNull },
      });
      return;
    }

    const state: SelectingDatetimeState = {
      step: 'selecting_datetime',
      serviceId: service.id,
      serviceName: service.name,
      price: service.price,
      prerequisites: service.prerequisites,
      suggestedSlot: nextSlot.toISOString(),
    };

    await this.updateState(conversation.id, state);

    const slotLabel = `${this.capitalize(this.fmtDate(nextSlot))} a las ${this.fmtTime(nextSlot)}`;
    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      `El próximo horario disponible para ${service.name} es:\n${slotLabel}\n\n¿Le viene bien ese horario o prefiere otro?`,
    );
  }

  // ── Step 2: Datetime decision ─────────────────────────────────────────────────

  private async handleDatetimeDecision(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
    state: SelectingDatetimeState,
  ): Promise<void> {
    const now = new Date();
    const suggested = new Date(state.suggestedSlot);

    const parsed = await this.callClaude<{
      action: 'accept_suggestion' | 'provide_preference' | 'specific_datetime';
      startsAt?: string;
      startDate?: string;
      endDate?: string;
      timeOfDay?: 'morning' | 'afternoon' | 'evening' | null;
    }>(
      `Hoy es ${this.fmtDate(now)}, hora actual: ${this.fmtTime(now)}.
El horario sugerido fue: ${this.capitalize(this.fmtDate(suggested))} a las ${this.fmtTime(suggested)}.
El paciente respondió: "${text}"

Interpreta su respuesta. Responde SOLO con JSON válido:
- Acepta el horario sugerido → {"action": "accept_suggestion"}
- Da una preferencia de día/rango → {"action": "provide_preference", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "timeOfDay": "morning"|"afternoon"|"evening"|null}
- Da fecha y hora específica → {"action": "specific_datetime", "startsAt": "ISO 8601"}

Considera "mañana" = ${format(addDays(now, 1), 'yyyy-MM-dd')}, "esta semana" termina el ${format(this.endOfWeek(now), 'yyyy-MM-dd')}, etc.`,
      150,
    );

    if (!parsed) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        '¿Desea ese horario o prefiere otro? Puede indicarme el día y la hora que prefiere.',
      );
      return;
    }

    if (parsed.action === 'accept_suggestion') {
      await this.showConfirmation(clinicId, conversation, patient, new Date(state.suggestedSlot), state);
      return;
    }

    if (parsed.action === 'specific_datetime' && parsed.startsAt) {
      await this.checkAndConfirmSlot(clinicId, conversation, patient, new Date(parsed.startsAt), state);
      return;
    }

    if (parsed.action === 'provide_preference' && parsed.startDate && parsed.endDate) {
      await this.showSlotsForPreference(clinicId, conversation, patient, state, {
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        timeOfDay: parsed.timeOfDay ?? null,
      });
      return;
    }

    await this.whatsapp.sendText(
      clinicId,
      patient.phone,
      'Con gusto. ¿Tiene preferencia de día o rango de fechas?',
    );
  }

  // ── Step 2b: Check a specific slot and move to confirming ────────────────────

  private async checkAndConfirmSlot(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    startsAt: Date,
    serviceState: { serviceId: string; serviceName: string; price: number; prerequisites: string | null },
  ): Promise<void> {
    if (!isAfter(startsAt, new Date())) {
      await this.whatsapp.sendText(clinicId, patient.phone, 'Ese horario ya pasó. ¿Cuál otro prefiere?');
      return;
    }

    const service = await this.prisma.service.findUnique({ where: { id: serviceState.serviceId } });
    if (!service) return;

    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
    const { available } = await this.availability.checkSlot(clinicId, startsAt, endsAt);

    if (available) {
      await this.showConfirmation(clinicId, conversation, patient, startsAt, serviceState);
      return;
    }

    // Not available — show nearby alternatives
    const alternatives = await this.findSlotsAround(clinicId, serviceState.serviceId, startsAt);

    if (alternatives.length === 0) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `Lo siento, ese horario no está disponible y no hay alternativas cercanas. ¿Prefiere otro día?`,
      );
      return;
    }

    await this.showBrowsingSlots(clinicId, conversation, patient, alternatives, serviceState, 'no disponible');
  }

  // ── Step 2c: Show available slots for a preference ───────────────────────────

  private async showSlotsForPreference(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    serviceState: { serviceId: string; serviceName: string; price: number; prerequisites: string | null },
    preference: { startDate: string; endDate: string; timeOfDay: string | null },
  ): Promise<void> {
    const slots = await this.findSlotsInRange(
      clinicId,
      serviceState.serviceId,
      preference.startDate,
      preference.endDate,
      preference.timeOfDay,
    );

    if (slots.length === 0) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `No tenemos disponibilidad para ${serviceState.serviceName} en esos días. ¿Desea que le indique el próximo horario disponible?`,
      );
      // Stay in selecting_datetime so patient can respond
      return;
    }

    await this.showBrowsingSlots(clinicId, conversation, patient, slots, serviceState);
  }

  // ── Step 3: Slot browsing (patient picks from a shown list) ──────────────────

  private async handleSlotSelection(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
    state: BrowsingSlotsState,
  ): Promise<void> {
    const slotLabels = state.shownSlots
      .map((s, i) => `${i + 1}. ${this.capitalize(this.fmtDate(new Date(s)))} a las ${this.fmtTime(new Date(s))}`)
      .join('\n');

    const matched = await this.callClaude<{ selected: boolean; index?: number }>(
      `Horarios mostrados:
${slotLabels}

El paciente respondió: "${text}"

¿Seleccionó uno? Responde SOLO JSON:
{"selected": true, "index": 0} (índice 0-based) o {"selected": false}`,
      60,
    );

    if (!matched || !matched.selected || matched.index === undefined) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'No entendí cuál horario prefiere. Por favor indíqueme el número del horario o diga el día y la hora que desea.',
      );
      return;
    }

    const selectedSlot = state.shownSlots[matched.index];
    if (!selectedSlot) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'No pude identificar ese horario. ¿Puede indicarme el número de la lista?',
      );
      return;
    }

    await this.showConfirmation(clinicId, conversation, patient, new Date(selectedSlot), state);
  }

  // ── Step 4: Confirmation ──────────────────────────────────────────────────────

  private async handleConfirmation(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
    state: ConfirmingState,
  ): Promise<void> {
    const decision = await this.callClaude<{ action: 'confirm' | 'deny' }>(
      `El paciente respondió: "${text}"
¿Está confirmando o rechazando la cita? Responde SOLO JSON:
{"action": "confirm"} o {"action": "deny"}`,
      40,
    );

    if (!decision) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        '¿Confirmamos su cita? Por favor responda sí o no.',
      );
      return;
    }

    if (decision.action === 'deny') {
      await this.resetFlow(conversation.id);
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'Entendido. Cuando desee agendar su cita, estamos a su disposición.',
      );
      return;
    }

    // Confirm — create appointment
    const startsAt = new Date(state.startsAt);
    const service = await this.prisma.service.findUnique({ where: { id: state.serviceId } });
    if (!service) {
      await this.resetFlow(conversation.id);
      return;
    }

    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

    // Re-validate availability (slot may have been taken since patient selected it)
    const { available, reason } = await this.availability.checkSlot(clinicId, startsAt, endsAt);
    if (!available) {
      const alternatives = await this.findSlotsAround(clinicId, state.serviceId, startsAt);
      if (alternatives.length > 0) {
        await this.showBrowsingSlots(clinicId, conversation, patient, alternatives, state, 'tomado');
      } else {
        await this.whatsapp.sendText(
          clinicId,
          patient.phone,
          `Lo siento, ese horario acaba de ser ocupado. ¿Desea elegir otro?`,
        );
        await this.updateState(conversation.id, { step: 'selecting_service' });
      }
      return;
    }

    const hoursUntil = differenceInHours(startsAt, new Date());
    const appointmentStatus = hoursUntil > 24 ? 'PENDING' : 'CONFIRMED';

    await this.prisma.appointment.create({
      data: {
        clinicId,
        patientId: patient.id,
        serviceId: state.serviceId,
        startsAt,
        endsAt,
        price: state.price,
        status: appointmentStatus,
        createdBy: CreatedBy.BOT,
      },
    });

    await this.resetFlow(conversation.id);

    // MSG-02 (>24h) or MSG-03 (≤24h)
    const confirmText =
      hoursUntil > 24
        ? `Su cita ha sido agendada. Le estaremos recordando 24 horas antes para confirmar. Si necesita cancelar o cambiar la fecha, no dude en escribirnos.`
        : `Su cita ha sido agendada. Le esperamos el ${this.fmtDate(startsAt)} a las ${this.fmtTime(startsAt)}. Si necesita cancelar o cambiar la fecha, no dude en escribirnos.`;

    await this.whatsapp.sendText(clinicId, patient.phone, confirmText);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Show the confirmation summary before creating the appointment. */
  private async showConfirmation(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    startsAt: Date,
    serviceState: { serviceId: string; serviceName: string; price: number; prerequisites: string | null },
  ): Promise<void> {
    const newState: ConfirmingState = {
      step: 'confirming',
      serviceId: serviceState.serviceId,
      serviceName: serviceState.serviceName,
      startsAt: startsAt.toISOString(),
      price: serviceState.price,
      prerequisites: serviceState.prerequisites,
    };

    await this.updateState(conversation.id, newState);

    const lines = [
      'Perfecto. Voy a confirmar su cita:',
      '',
      `Servicio: ${serviceState.serviceName}`,
      `Fecha: ${this.capitalize(this.fmtDate(startsAt))}`,
      `Hora: ${this.fmtTime(startsAt)}`,
      `Precio: RD$${serviceState.price}`,
    ];
    if (serviceState.prerequisites) {
      lines.push(`Importante: ${serviceState.prerequisites}`);
    }
    lines.push('', '¿Confirmamos?');

    await this.whatsapp.sendText(clinicId, patient.phone, lines.join('\n'));
  }

  /** Format and display a list of browsable slots, grouped by date. */
  private async showBrowsingSlots(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    slots: Date[],
    serviceState: { serviceId: string; serviceName: string; price: number; prerequisites: string | null },
    context?: string,
  ): Promise<void> {
    const state: BrowsingSlotsState = {
      step: 'browsing_slots',
      serviceId: serviceState.serviceId,
      serviceName: serviceState.serviceName,
      price: serviceState.price,
      prerequisites: serviceState.prerequisites,
      shownSlots: slots.map((s) => s.toISOString()),
    };

    await this.updateState(conversation.id, state);

    // Group slots by date
    const grouped = new Map<string, Date[]>();
    for (const slot of slots) {
      const dateKey = format(slot, 'yyyy-MM-dd');
      if (!grouped.has(dateKey)) grouped.set(dateKey, []);
      grouped.get(dateKey)!.push(slot);
    }

    const lines: string[] = [];
    if (context === 'no disponible') {
      lines.push(`Lo siento, ese horario no está disponible. Los horarios más cercanos para ${serviceState.serviceName} son:`);
    } else if (context === 'tomado') {
      lines.push(`Ese horario fue tomado. Los próximos disponibles son:`);
    } else {
      lines.push(`Estos son los horarios disponibles para ${serviceState.serviceName}:`);
    }
    lines.push('');

    for (const [, daySlots] of grouped) {
      const dateLabel = this.capitalize(this.fmtDate(daySlots[0]));
      const times = daySlots.map((s) => this.fmtTime(s)).join(', ');
      lines.push(`• ${dateLabel} — ${times}`);
    }

    lines.push('', '¿Cuál prefiere?');
    await this.whatsapp.sendText(clinicId, patient.phone, lines.join('\n'));
  }

  private async findNextSlot(clinicId: string, serviceId: string): Promise<Date | null> {
    for (let i = 0; i < LOOK_AHEAD_DAYS; i++) {
      const date = addDays(new Date(), i);
      const dateStr = format(date, 'yyyy-MM-dd');
      try {
        const slots = await this.availability.getAvailableSlots(clinicId, dateStr, serviceId);
        if (slots.length > 0) return new Date(slots[0]);
      } catch {
        continue;
      }
    }
    return null;
  }

  private async findSlotsInRange(
    clinicId: string,
    serviceId: string,
    startDate: string,
    endDate: string,
    timeOfDay: string | null,
  ): Promise<Date[]> {
    const slots: Date[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      try {
        const daySlots = await this.availability.getAvailableSlots(
          clinicId,
          format(d, 'yyyy-MM-dd'),
          serviceId,
        );
        for (const s of daySlots) {
          const slotDate = new Date(s);
          if (timeOfDay) {
            const h = slotDate.getHours();
            if (timeOfDay === 'morning' && h >= 12) continue;
            if (timeOfDay === 'afternoon' && (h < 12 || h >= 18)) continue;
            if (timeOfDay === 'evening' && h < 18) continue;
          }
          slots.push(slotDate);
          if (slots.length >= MAX_SLOTS_SHOWN) break;
        }
      } catch {
        continue;
      }
      if (slots.length >= MAX_SLOTS_SHOWN) break;
    }
    return slots;
  }

  /** Find available slots around a given datetime (same day + next 2 days). */
  private async findSlotsAround(
    clinicId: string,
    serviceId: string,
    around: Date,
  ): Promise<Date[]> {
    return this.findSlotsInRange(
      clinicId,
      serviceId,
      format(around, 'yyyy-MM-dd'),
      format(addDays(around, 2), 'yyyy-MM-dd'),
      null,
    );
  }

  private async updateState(conversationId: string, state: CreateAppointmentState): Promise<void> {
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

  /** Single-purpose Claude call that returns parsed JSON or null on failure. */
  private async callClaude<T>(prompt: string, maxTokens: number): Promise<T | null> {
    try {
      const result = await this.intent.callJson<T>(prompt, maxTokens);
      return result;
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

  private endOfWeek(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = 6 - day; // days until Saturday
    d.setDate(d.getDate() + diff);
    return d;
  }
}
