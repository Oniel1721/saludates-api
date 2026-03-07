import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EnvironmentService } from '@/config/environment.service';

interface WebhookPayload {
  event: string;
  sessionId: string;
  data?: {
    qrCode?: string;
    phoneNumber?: string;
    from?: string;
    text?: string;
    type?: string;
    [key: string]: unknown;
  };
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly baseUrl = 'https://api.wasenderapi.com';

  // In-memory QR cache: clinicId → qrCode (base64).
  // QR codes are short-lived (~20s), so in-memory is fine for MVP.
  private readonly qrCache = new Map<string, string>();

  constructor(
    private prisma: PrismaService,
    private env: EnvironmentService,
  ) {}

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.env.wasenderApiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`WasenderAPI ${method} ${path} → ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Creates a WasenderAPI session for the clinic and returns the QR code to scan.
   * If a previous session exists, it is deleted first.
   */
  async connect(clinicId: string, phone: string): Promise<{ qrCode: string }> {
    const sessionId = `clinic-${clinicId}`;
    const webhookUrl = `${this.env.apiBaseUrl}/whatsapp/webhook`;

    // Clean up any existing session on WasenderAPI's side
    const existing = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { whatsappSessionId: true },
    });

    if (existing?.whatsappSessionId) {
      try {
        await this.request('DELETE', `/api/sessions/${existing.whatsappSessionId}`);
      } catch {
        // Session might already be gone on WasenderAPI's side — ignore
      }
    }

    const data = await this.request<{ qrCode: string }>('POST', '/api/sessions', {
      name: sessionId,
      webhookUrl,
    });

    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: {
        whatsappPhone: phone,
        whatsappSessionId: sessionId,
        whatsappStatus: WhatsAppStatus.PENDING_QR,
      },
    });

    this.qrCache.set(clinicId, data.qrCode);
    return { qrCode: data.qrCode };
  }

  /** Returns the current connection status from the DB plus cached QR if pending. */
  async getStatus(clinicId: string) {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { whatsappStatus: true, whatsappPhone: true },
    });

    return {
      status: clinic.whatsappStatus,
      phone: clinic.whatsappPhone,
      qrCode:
        clinic.whatsappStatus === WhatsAppStatus.PENDING_QR
          ? (this.qrCache.get(clinicId) ?? null)
          : null,
    };
  }

  /** Deletes the WasenderAPI session and marks the clinic as disconnected. */
  async disconnect(clinicId: string): Promise<void> {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { whatsappSessionId: true },
    });

    if (clinic.whatsappSessionId) {
      try {
        await this.request('DELETE', `/api/sessions/${clinic.whatsappSessionId}`);
      } catch {
        this.logger.warn(`Failed to delete WasenderAPI session for clinic ${clinicId}`);
      }
    }

    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { whatsappSessionId: null, whatsappStatus: WhatsAppStatus.DISCONNECTED },
    });

    this.qrCache.delete(clinicId);
  }

  /**
   * Sends a plain-text WhatsApp message from the clinic's number.
   * Silently logs and returns if the clinic is not connected (does not throw),
   * so callers (appointments, scheduler) don't need to worry about the connection state.
   */
  async sendText(clinicId: string, to: string, text: string): Promise<void> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { whatsappSessionId: true, whatsappStatus: true },
    });

    if (!clinic?.whatsappSessionId || clinic.whatsappStatus !== WhatsAppStatus.CONNECTED) {
      this.logger.warn(`Skipping WhatsApp send: clinic ${clinicId} not connected`);
      return;
    }

    try {
      await this.request('POST', '/api/messages/send-text', {
        sessionId: clinic.whatsappSessionId,
        to: `${to}@c.us`, // WasenderAPI expects WhatsApp JID format
        text,
      });
    } catch (err) {
      this.logger.error(`Failed to send WhatsApp message to ${to} for clinic ${clinicId}: ${err}`);
    }
  }

  /**
   * Processes an incoming webhook event from WasenderAPI.
   * - qr: QR refreshed, cache it and keep status as PENDING_QR
   * - ready: connection established, update to CONNECTED
   * - disconnected: update to DISCONNECTED
   * - message: incoming patient message — handled by the bot module (T-20)
   */
  async handleWebhook(payload: WebhookPayload): Promise<void> {
    const { event, sessionId, data } = payload;

    const clinic = await this.prisma.clinic.findFirst({
      where: { whatsappSessionId: sessionId },
    });

    if (!clinic) {
      this.logger.warn(`Webhook received for unknown session: ${sessionId}`);
      return;
    }

    this.logger.log(`WhatsApp webhook event="${event}" clinic=${clinic.id}`);

    switch (event) {
      case 'qr':
        await this.prisma.clinic.update({
          where: { id: clinic.id },
          data: { whatsappStatus: WhatsAppStatus.PENDING_QR },
        });
        if (data?.qrCode) {
          this.qrCache.set(clinic.id, data.qrCode);
        }
        break;

      case 'ready':
        await this.prisma.clinic.update({
          where: { id: clinic.id },
          data: {
            whatsappStatus: WhatsAppStatus.CONNECTED,
            ...(data?.phoneNumber ? { whatsappPhone: data.phoneNumber } : {}),
          },
        });
        this.qrCache.delete(clinic.id);
        break;

      case 'disconnected':
        await this.prisma.clinic.update({
          where: { id: clinic.id },
          data: { whatsappStatus: WhatsAppStatus.DISCONNECTED },
        });
        this.qrCache.delete(clinic.id);
        break;

      case 'message':
        // Incoming patient messages are handled by the bot module (T-20).
        // The bot module will listen for this event via an injectable hook.
        break;

      default:
        this.logger.debug(`Unhandled webhook event: ${event}`);
    }
  }
}
