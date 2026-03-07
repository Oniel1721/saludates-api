import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { EnvironmentService } from '@/config/environment.service';

export type BotIntent =
  | 'CREATE_APPOINTMENT'
  | 'CANCEL_APPOINTMENT'
  | 'RESCHEDULE_APPOINTMENT'
  | 'QUERY_APPOINTMENTS'
  | 'QUERY_SERVICES'
  | 'CONFIRM'
  | 'DENY'
  | 'GREETING'
  | 'UNRELATED'
  | 'ESCALATE';

export interface ClassifyParams {
  clinicName: string;
  patientName: string;
  patientMessage: string;
  currentFlow: string;
  recentMessages: Array<{ sender: string; text: string }>;
}

export interface ClassifyResult {
  intent: BotIntent;
  confidence: 'high' | 'low';
}

@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);
  private readonly client: Anthropic;

  constructor(private env: EnvironmentService) {
    this.client = new Anthropic({ apiKey: env.anthropicApiKey });
  }

  /**
   * Classifies the patient's intent using Claude.
   * Returns ESCALATE with low confidence if Claude fails or is uncertain.
   */
  async classifyIntent(params: ClassifyParams): Promise<ClassifyResult> {
    const context =
      params.recentMessages.length > 0
        ? params.recentMessages.map((m) => `${m.sender}: ${m.text}`).join('\n')
        : '(inicio de conversación)';

    const prompt = `Eres un clasificador de intenciones para el bot de WhatsApp del consultorio médico "${params.clinicName}" en República Dominicana.

Paciente: ${params.patientName}
Flujo actual: ${params.currentFlow}

Conversación reciente:
${context}

Mensaje del paciente: "${params.patientMessage}"

Clasifica la intención. Responde SOLO con JSON válido, sin explicaciones:
{"intent": "...", "confidence": "high" | "low"}

Intenciones posibles:
- CREATE_APPOINTMENT: quiere agendar una cita
- CANCEL_APPOINTMENT: quiere cancelar una cita
- RESCHEDULE_APPOINTMENT: quiere cambiar la fecha/hora de una cita
- QUERY_APPOINTMENTS: pregunta por sus citas pendientes o próximas
- QUERY_SERVICES: pregunta por servicios, precios o disponibilidad
- CONFIRM: está confirmando algo (sí, correcto, ok, de acuerdo, confirmado)
- DENY: está negando o rechazando (no, cancela, no gracias, no puedo)
- GREETING: saludo simple sin otra intención clara (hola, buenos días, etc.)
- UNRELATED: mensaje completamente ajeno al consultorio
- ESCALATE: urgente, queja, frustración, o no puedes clasificar con certeza

Usa "low" si no estás seguro. Usa ESCALATE con "low" para situaciones urgentes o de queja.`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
      const parsed = JSON.parse(text) as { intent: BotIntent; confidence: 'high' | 'low' };
      return { intent: parsed.intent, confidence: parsed.confidence };
    } catch (err) {
      this.logger.warn(`Intent classification failed: ${err}`);
      return { intent: 'ESCALATE', confidence: 'low' };
    }
  }

  /**
   * Low-level helper: calls Claude with a prompt and parses the response as JSON.
   * Used by flow handlers for focused, single-purpose classifications (service matching,
   * datetime parsing, confirm/deny, slot selection).
   * Throws on parse failure so callers can handle gracefully.
   */
  async callJson<T>(prompt: string, maxTokens: number): Promise<T> {
    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    return JSON.parse(text) as T;
  }

  /**
   * Generates a contextual response in formal Spanish for the clinic's WhatsApp bot.
   * Used as a fallback for intents that don't have a specific flow handler yet (T-21..T-26).
   */
  async generateResponse(params: ClassifyParams & { intent: BotIntent }): Promise<string> {
    const context =
      params.recentMessages.length > 0
        ? params.recentMessages.map((m) => `${m.sender}: ${m.text}`).join('\n')
        : '(inicio de conversación)';

    const prompt = `Eres el asistente de WhatsApp del consultorio médico "${params.clinicName}" en República Dominicana.
Escribes en nombre del consultorio con tono formal. No te identificas como bot.

Paciente: ${params.patientName}
Intención detectada: ${params.intent}

Conversación reciente:
${context}

El paciente escribió: "${params.patientMessage}"

Escribe una respuesta breve y apropiada en español formal. Solo el texto del mensaje, sin comillas ni explicaciones adicionales.`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });

      return response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    } catch (err) {
      this.logger.warn(`Response generation failed: ${err}`);
      return 'Disculpe, estamos experimentando dificultades técnicas. Por favor intente de nuevo en unos momentos.';
    }
  }
}
