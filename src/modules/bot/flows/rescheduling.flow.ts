import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConversationFlow, Prisma } from '@prisma/client';
import { addDays, format, isAfter } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { AvailabilityService } from '@/modules/availability/availability.service';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { BotService, FlowConversation, FlowHandler, FlowPatient } from '@/modules/bot/bot.service';
import { IntentService } from '@/modules/bot/intent.service';

// ─── Flow state shapes ────────────────────────────────────────────────────────

type SelectingAppointmentState = {
  step: 'selecting_appointment';
  appointmentIds: string[];
};

type SelectingDatetimeState = {
  step: 'selecting_datetime';
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  price: number;
  prerequisites: string | null;
  suggestedSlot: string; // ISO
};

type BrowsingSlotsState = {
  step: 'browsing_slots';
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  price: number;
  prerequisites: string | null;
  shownSlots: string[]; // ISO[]
};

type ConfirmingState = {
  step: 'confirming';
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  price: number;
  prerequisites: string | null;
  newStartsAt: string; // ISO
};

type ReschedulingState =
  | SelectingAppointmentState
  | SelectingDatetimeState
  | BrowsingSlotsState
  | ConfirmingState;

// ─── Constants ────────────────────────────────────────────────────────────────

const LOOK_AHEAD_DAYS = 14;
const MAX_SLOTS_SHOWN = 6;

// ─── ReschedulingFlow ─────────────────────────────────────────────────────────

/**
 * Flow 4 — Reschedule appointment via bot (T-24).
 *
 * Triggered by RESCHEDULE_APPOINTMENT intent (dispatchIntent) OR
 * from ConfirmingFlow when the patient wants to reschedule (T-22).
 *
 * When coming from T-22, flowState already contains { appointmentId },
 * so start() skips appointment selection and goes straight to datetime.
 *
 * Steps:
 *   1. Identify appointment (if multiple pending)
 *   2. Select new date/time (same logic as CreateAppointmentFlow step 3)
 *   3. Confirm → update startsAt/endsAt, status stays PENDING, MSG-07
 */
@Injectable()
export class ReschedulingFlow implements FlowHandler, OnModuleInit {
  private readonly logger = new Logger(ReschedulingFlow.name);

  constructor(
    private prisma: PrismaService,
    private availability: AvailabilityService,
    private whatsapp: WhatsAppService,
    private intent: IntentService,
    private bot: BotService,
  ) {}

  onModuleInit() {
    this.bot.registerFlowHandler(ConversationFlow.RESCHEDULING, this);
  }

  // ── FlowHandler ──────────────────────────────────────────────────────────────

  async start(clinicId: string, conversation: FlowConversation, patient: FlowPatient): Promise<void> {
    // When coming from ConfirmingFlow (T-22), appointmentId is already in flowState
    const incoming = conversation.flowState as { appointmentId?: string } | null;
    if (incoming?.appointmentId) {
      await this.startDatetimeSelection(clinicId, conversation, patient, incoming.appointmentId);
      return;
    }

    const appointments = await this.fetchReschedulableAppointments(clinicId, patient.id);

    if (appointments.length === 0) {
      await this.resetFlow(conversation.id);
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'No tiene citas pendientes para reagendar. ¿En qué le puedo ayudar?',
      );
      return;
    }

    if (appointments.length === 1) {
      await this.startDatetimeSelection(clinicId, conversation, patient, appointments[0].id);
      return;
    }

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
      `Tiene las siguientes citas pendientes:\n\n${lines.join('\n')}\n\n¿Cuál desea reagendar?`,
    );
  }

  async handleStep(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    text: string,
  ): Promise<void> {
    const state = conversation.flowState as ReschedulingState | null;

    switch (state?.step) {
      case 'selecting_appointment':
        await this.handleAppointmentSelection(clinicId, conversation, patient, text, state);
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
        await this.start(clinicId, conversation, patient);
    }
  }

  // ── Step 1: Appointment selection ─────────────────────────────────────────────

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
      `El paciente quiere reagendar una cita. Estas son las citas disponibles:
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
        `No entendí cuál cita desea reagendar. Por favor indique el número:\n\n${lines.join('\n')}`,
      );
      return;
    }

    await this.startDatetimeSelection(clinicId, conversation, patient, matched.appointmentId);
  }

  // ── Step 2: Datetime selection ────────────────────────────────────────────────

  private async startDatetimeSelection(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    appointmentId: string,
  ): Promise<void> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { service: true },
    });

    if (!appointment) {
      await this.resetFlow(conversation.id);
      return;
    }

    const { service } = appointment;
    const nextSlot = await this.findNextSlot(clinicId, service.id, appointmentId);

    if (!nextSlot) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `En este momento no tenemos horarios disponibles para ${service.name}. ¿Desea que le contactemos cuando se abra un espacio?`,
      );
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { flow: ConversationFlow.ESCALATED, flowState: Prisma.JsonNull },
      });
      return;
    }

    const state: SelectingDatetimeState = {
      step: 'selecting_datetime',
      appointmentId,
      serviceId: service.id,
      serviceName: service.name,
      price: appointment.price,
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

  private async checkAndConfirmSlot(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    startsAt: Date,
    state: SelectingDatetimeState,
  ): Promise<void> {
    if (!isAfter(startsAt, new Date())) {
      await this.whatsapp.sendText(clinicId, patient.phone, 'Ese horario ya pasó. ¿Cuál otro prefiere?');
      return;
    }

    const service = await this.prisma.service.findUnique({ where: { id: state.serviceId } });
    if (!service) return;

    const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);
    const { available } = await this.availability.checkSlot(
      clinicId,
      startsAt,
      endsAt,
      state.appointmentId, // exclude current appointment from conflict check
    );

    if (available) {
      await this.showConfirmation(clinicId, conversation, patient, startsAt, state);
      return;
    }

    const alternatives = await this.findSlotsInRange(
      clinicId,
      state.serviceId,
      format(startsAt, 'yyyy-MM-dd'),
      format(addDays(startsAt, 2), 'yyyy-MM-dd'),
      null,
      state.appointmentId,
    );

    if (alternatives.length === 0) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'Lo siento, ese horario no está disponible y no hay alternativas cercanas. ¿Prefiere otro día?',
      );
      return;
    }

    await this.showBrowsingSlots(clinicId, conversation, patient, alternatives, state, 'no disponible');
  }

  private async showSlotsForPreference(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    state: SelectingDatetimeState,
    preference: { startDate: string; endDate: string; timeOfDay: string | null },
  ): Promise<void> {
    const slots = await this.findSlotsInRange(
      clinicId,
      state.serviceId,
      preference.startDate,
      preference.endDate,
      preference.timeOfDay,
      state.appointmentId,
    );

    if (slots.length === 0) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        `No tenemos disponibilidad para ${state.serviceName} en esos días. ¿Desea que le indique el próximo horario disponible?`,
      );
      return;
    }

    await this.showBrowsingSlots(clinicId, conversation, patient, slots, state);
  }

  // ── Step 3: Slot browsing ─────────────────────────────────────────────────────

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
      `Horarios mostrados:\n${slotLabels}\n\nEl paciente respondió: "${text}"\n\n¿Seleccionó uno? Responde SOLO JSON:\n{"selected": true, "index": 0} (índice 0-based) o {"selected": false}`,
      60,
    );

    if (!matched?.selected || matched.index === undefined) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'No entendí cuál horario prefiere. Por favor indíqueme el número del horario.',
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
      `El paciente debe confirmar el reagendamiento de su cita.
El paciente respondió: "${text}"

¿Está confirmando o rechazando el cambio? Responde SOLO JSON:
{"action": "confirm"} o {"action": "deny"}`,
      40,
    );

    if (!decision) {
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        '¿Confirmamos el cambio? Por favor responda sí o no.',
      );
      return;
    }

    if (decision.action === 'deny') {
      await this.resetFlow(conversation.id);
      await this.whatsapp.sendText(
        clinicId,
        patient.phone,
        'Entendido, su cita original se mantiene sin cambios.',
      );
      return;
    }

    // Confirm — re-validate and update appointment
    const newStartsAt = new Date(state.newStartsAt);
    const service = await this.prisma.service.findUnique({ where: { id: state.serviceId } });
    if (!service) {
      await this.resetFlow(conversation.id);
      return;
    }

    const newEndsAt = new Date(newStartsAt.getTime() + service.durationMinutes * 60_000);
    const { available } = await this.availability.checkSlot(
      clinicId,
      newStartsAt,
      newEndsAt,
      state.appointmentId,
    );

    if (!available) {
      // Slot was taken — show alternatives
      const alternatives = await this.findSlotsInRange(
        clinicId,
        state.serviceId,
        format(newStartsAt, 'yyyy-MM-dd'),
        format(addDays(newStartsAt, 2), 'yyyy-MM-dd'),
        null,
        state.appointmentId,
      );

      if (alternatives.length > 0) {
        await this.showBrowsingSlots(clinicId, conversation, patient, alternatives, state, 'tomado');
      } else {
        await this.whatsapp.sendText(
          clinicId,
          patient.phone,
          'Lo siento, ese horario acaba de ser ocupado. ¿Desea elegir otro?',
        );
        await this.updateState(conversation.id, {
          step: 'selecting_datetime',
          appointmentId: state.appointmentId,
          serviceId: state.serviceId,
          serviceName: state.serviceName,
          price: state.price,
          prerequisites: state.prerequisites,
          suggestedSlot: state.newStartsAt,
        });
      }
      return;
    }

    await this.prisma.appointment.update({
      where: { id: state.appointmentId },
      data: {
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        status: 'PENDING',
        reminderSentAt: null,
      },
    });

    await this.resetFlow(conversation.id);

    // MSG-07
    const lines = [
      'Listo, su cita ha sido actualizada:',
      '',
      `Servicio: ${state.serviceName}`,
      `Nueva fecha: ${this.capitalize(this.fmtDate(newStartsAt))}`,
      `Nueva hora: ${this.fmtTime(newStartsAt)}`,
      `Precio: RD$${state.price}`,
      '',
      'Le estaremos recordando 24 horas antes para confirmar su asistencia.',
    ];

    await this.whatsapp.sendText(clinicId, patient.phone, lines.join('\n'));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private async showConfirmation(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    newStartsAt: Date,
    serviceState: {
      appointmentId: string;
      serviceId: string;
      serviceName: string;
      price: number;
      prerequisites: string | null;
    },
  ): Promise<void> {
    const newState: ConfirmingState = {
      step: 'confirming',
      appointmentId: serviceState.appointmentId,
      serviceId: serviceState.serviceId,
      serviceName: serviceState.serviceName,
      price: serviceState.price,
      prerequisites: serviceState.prerequisites,
      newStartsAt: newStartsAt.toISOString(),
    };

    await this.updateState(conversation.id, newState);

    const lines = [
      'Su cita queda reagendada:',
      '',
      `Servicio: ${serviceState.serviceName}`,
      `Nueva fecha: ${this.capitalize(this.fmtDate(newStartsAt))}`,
      `Nueva hora: ${this.fmtTime(newStartsAt)}`,
      `Precio: RD$${serviceState.price}`,
    ];
    if (serviceState.prerequisites) {
      lines.push(`Importante: ${serviceState.prerequisites}`);
    }
    lines.push('', '¿Confirmamos el cambio?');

    await this.whatsapp.sendText(clinicId, patient.phone, lines.join('\n'));
  }

  private async showBrowsingSlots(
    clinicId: string,
    conversation: FlowConversation,
    patient: FlowPatient,
    slots: Date[],
    serviceState: {
      appointmentId: string;
      serviceId: string;
      serviceName: string;
      price: number;
      prerequisites: string | null;
    },
    context?: string,
  ): Promise<void> {
    const state: BrowsingSlotsState = {
      step: 'browsing_slots',
      appointmentId: serviceState.appointmentId,
      serviceId: serviceState.serviceId,
      serviceName: serviceState.serviceName,
      price: serviceState.price,
      prerequisites: serviceState.prerequisites,
      shownSlots: slots.map((s) => s.toISOString()),
    };
    await this.updateState(conversation.id, state);

    const grouped = new Map<string, Date[]>();
    for (const slot of slots) {
      const key = format(slot, 'yyyy-MM-dd');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(slot);
    }

    const lines: string[] = [];
    if (context === 'no disponible') {
      lines.push(`Lo siento, ese horario no está disponible. Los horarios más cercanos para ${serviceState.serviceName} son:`);
    } else if (context === 'tomado') {
      lines.push('Ese horario fue tomado. Los próximos disponibles son:');
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

  private async fetchReschedulableAppointments(clinicId: string, patientId: string) {
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

  private async findNextSlot(
    clinicId: string,
    serviceId: string,
    excludeAppointmentId: string,
  ): Promise<Date | null> {
    for (let i = 0; i < LOOK_AHEAD_DAYS; i++) {
      const date = addDays(new Date(), i);
      const dateStr = format(date, 'yyyy-MM-dd');
      try {
        const slots = await this.availability.getAvailableSlots(
          clinicId,
          dateStr,
          serviceId,
          excludeAppointmentId,
        );
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
    excludeAppointmentId: string,
  ): Promise<Date[]> {
    const slots: Date[] = [];
    const end = new Date(endDate);

    for (let d = new Date(startDate); d <= end; d = addDays(d, 1)) {
      try {
        const daySlots = await this.availability.getAvailableSlots(
          clinicId,
          format(d, 'yyyy-MM-dd'),
          serviceId,
          excludeAppointmentId,
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

  private async updateState(conversationId: string, state: ReschedulingState): Promise<void> {
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

  private endOfWeek(date: Date): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + (6 - d.getDay()));
    return d;
  }
}
