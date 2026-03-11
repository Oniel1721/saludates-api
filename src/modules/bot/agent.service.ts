import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { MessageSender, MessageType } from '@prisma/client';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { EnvironmentService } from '@/config/environment.service';
import { BotToolsService } from '@/modules/bot/bot-tools.service';

const MAX_TOOL_ITERATIONS = 10;

const BOT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_services',
    description: 'Obtiene la lista de servicios disponibles en el consultorio con sus precios y duración.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_patient_appointments',
    description: 'Obtiene las citas pendientes y confirmadas del paciente.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'find_available_slots',
    description:
      'Busca horarios disponibles para un servicio. Devuelve hasta 8 horarios en formato ISO 8601. Puede filtrar por rango de fechas y preferencia horaria.',
    input_schema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string', description: 'ID del servicio' },
        startDate: {
          type: 'string',
          description: 'Fecha de inicio YYYY-MM-DD. Por defecto: hoy.',
        },
        endDate: {
          type: 'string',
          description: 'Fecha de fin YYYY-MM-DD. Por defecto: 14 días desde startDate.',
        },
        timePreference: {
          type: 'string',
          enum: ['morning', 'afternoon', 'evening'],
          description: 'morning = antes de 12h, afternoon = 12-18h, evening = después de 18h.',
        },
        excludeAppointmentId: {
          type: 'string',
          description: 'ID de la cita actual a excluir al reagendar.',
        },
      },
      required: ['serviceId'],
    },
  },
  {
    name: 'create_appointment',
    description:
      'Crea una nueva cita. Solo llamar cuando el paciente haya confirmado explícitamente la fecha y hora.',
    input_schema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string', description: 'ID del servicio' },
        startsAt: { type: 'string', description: 'Fecha y hora en ISO 8601' },
      },
      required: ['serviceId', 'startsAt'],
    },
  },
  {
    name: 'cancel_appointment',
    description:
      'Cancela una cita. Solo llamar cuando el paciente haya confirmado que desea cancelar.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string', description: 'ID de la cita a cancelar' },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      'Reagenda una cita a una nueva fecha/hora. Solo llamar cuando el paciente haya confirmado el nuevo horario.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string', description: 'ID de la cita' },
        newStartsAt: { type: 'string', description: 'Nueva fecha y hora en ISO 8601' },
      },
      required: ['appointmentId', 'newStartsAt'],
    },
  },
  {
    name: 'confirm_appointment',
    description: 'Confirma la asistencia del paciente a una cita pendiente.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string', description: 'ID de la cita a confirmar' },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Escala la conversación a un secretario humano. Usar cuando: el paciente tiene queja o urgencia, hace una solicitud que el bot no puede resolver, o pide hablar con una persona.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Motivo del escalamiento' },
      },
      required: [],
    },
  },
];

export interface AgentRunParams {
  clinicName: string;
  clinicId: string;
  patient: { id: string; name: string; phone: string };
  conversationId: string;
}

export interface AgentRunResult {
  reply: string | null;
  escalated: boolean;
}

/**
 * Runs a Claude tool-use loop to handle a patient message.
 * Claude decides which tools to call (availability, appointments CRUD, escalation)
 * and returns a final text reply to send to the patient.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly client: Anthropic;

  constructor(
    private prisma: PrismaService,
    private tools: BotToolsService,
    private env: EnvironmentService,
  ) {
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  async runAgent(params: AgentRunParams): Promise<AgentRunResult> {
    const { clinicName, clinicId, patient, conversationId } = params;

    const systemPrompt = this.buildSystemPrompt(clinicName, patient.name);
    const messages = await this.buildMessages(conversationId);

    if (messages.length === 0) {
      this.logger.warn('No messages to process in agent run');
      return { reply: null, escalated: false };
    }

    let response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools: BOT_TOOLS,
      messages,
    });

    let iterations = 0;

    while (response.stop_reason === 'tool_use' && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      // Append assistant turn (may contain text + tool_use blocks)
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let escalated = false;

      for (const block of toolUseBlocks) {
        if (block.name === 'escalate_to_human') {
          escalated = true;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Conversación escalada.',
          });
          continue;
        }

        try {
          const result = await this.tools.executeTool(
            block.name,
            block.input as Record<string, unknown>,
            clinicId,
            patient.id,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          this.logger.warn(`Tool ${block.name} threw: ${err}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: 'Error al ejecutar la herramienta.' }),
          });
        }
      }

      if (escalated) {
        return { reply: null, escalated: true };
      }

      messages.push({ role: 'user', content: toolResults });

      response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        tools: BOT_TOOLS,
        messages,
      });
    }

    if (iterations >= MAX_TOOL_ITERATIONS) {
      this.logger.warn('Agent reached max tool iterations, escalating');
      return { reply: null, escalated: true };
    }

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    return { reply: textBlock?.text.trim() ?? null, escalated: false };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildSystemPrompt(clinicName: string, patientName: string): string {
    const now = new Date();
    const nowStr = format(now, "EEEE d 'de' MMMM 'de' yyyy, h:mm a", { locale: es });

    return `Eres el asistente virtual de WhatsApp del consultorio médico "${clinicName}" en República Dominicana.

Paciente: ${patientName}
Fecha y hora actual: ${nowStr}

Instrucciones:
- Responde siempre en español formal usando "usted"
- No te identifiques como bot ni como IA
- Solo puedes ayudar con temas del consultorio: citas, servicios y disponibilidad
- Usa las herramientas para consultar datos y ejecutar acciones
- Siempre confirma con el paciente antes de crear, cancelar o reagendar citas
- Para mensajes no relacionados con el consultorio, indica amablemente que solo puedes ayudar con temas del consultorio
- Si el paciente tiene una queja, urgencia o solicitud que no puedes manejar, usa escalate_to_human
- Sé conciso y claro en tus respuestas`;
  }

  private async buildMessages(conversationId: string): Promise<Anthropic.MessageParam[]> {
    const recent = await this.prisma.message.findMany({
      where: { conversationId, type: MessageType.TEXT },
      orderBy: { sentAt: 'desc' },
      take: 12,
      select: { sender: true, text: true },
    });

    recent.reverse();

    // Group consecutive messages by role (handles multiple consecutive msgs from same side)
    const grouped: { role: 'user' | 'assistant'; texts: string[] }[] = [];

    for (const msg of recent) {
      if (!msg.text) continue;
      const role = msg.sender === MessageSender.PATIENT ? 'user' : 'assistant';
      const last = grouped[grouped.length - 1];
      if (last && last.role === role) {
        last.texts.push(msg.text);
      } else {
        grouped.push({ role, texts: [msg.text] });
      }
    }

    // Claude requires messages to start with 'user'
    while (grouped.length > 0 && grouped[0].role === 'assistant') {
      grouped.shift();
    }

    return grouped.map((g) => ({
      role: g.role,
      content: g.texts.join('\n'),
    }));
  }
}
