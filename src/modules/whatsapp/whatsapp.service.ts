import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { EnvironmentService } from '@/config/environment.service';
import {
  WasenderClient,
  verifyWebhookSignature,
  WebhookPayload,
  SessionStatusPayload,
  QrCodeUpdatedPayload,
  MessageReceivedPayload,
  MessageUpsertPayload,
} from '@/lib/wasender';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  // In-memory QR cache: clinicId → qr string.
  // QR codes expire in ~45s, re-fetched on demand via getSessionQrCode.
  private readonly qrCache = new Map<string, string>();

  private get wasender() {
    return new WasenderClient(this.env.wasenderApiKey);
  }

  constructor(
    private prisma: PrismaService,
    private env: EnvironmentService,
  ) {}

  /**
   * Creates a WasenderAPI session for the clinic, connects it, and returns the QR string.
   * If the clinic already has a session, it is deleted first.
   */
  async connect(clinicId: string, phone: string): Promise<{ qrCode: string }> {
    const existing = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { whatsappSessionId: true },
    });

    // Clean up any existing session first
    if (existing.whatsappSessionId) {
      try {
        await this.wasender.deleteSession(existing.whatsappSessionId);
      } catch {
        // Session may already be gone on WasenderAPI's side
      }
    }

    const webhookUrl = `${this.env.apiBaseUrl}/whatsapp/webhook`;

    // 1. Create session (returns api_key + webhook_secret)
    const { data: session } = await this.wasender.createSession({
      name: `clinic-${clinicId}`,
      phone_number: phone,
      account_protection: false,
      log_messages: false,
      webhook_url: webhookUrl,
      webhook_enabled: true,
      webhook_events: ['session.status', 'qrcode.updated', 'messages.received'],
    });

    // 2. Connect session to get QR
    const { data: connectResult } = await this.wasender.connectSession(session.id);
    const qrCode = connectResult.qrCode ?? '';

    // 3. Persist session credentials
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: {
        whatsappPhone: phone,
        whatsappSessionId: session.id,
        whatsappApiKey: session.api_key,
        whatsappWebhookSecret: session.webhook_secret,
        whatsappStatus: WhatsAppStatus.PENDING_QR,
      },
    });

    if (qrCode) this.qrCache.set(clinicId, qrCode);

    return { qrCode };
  }

  /**
   * Returns current connection status from DB plus a fresh QR if pending.
   * Tries to refresh the QR from WasenderAPI when the cached one may have expired.
   */
  async getStatus(clinicId: string) {
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: {
        whatsappStatus: true,
        whatsappPhone: true,
        whatsappSessionId: true,
      },
    });

    let qrCode: string | null = null;

    if (clinic.whatsappStatus === WhatsAppStatus.PENDING_QR && clinic.whatsappSessionId) {
      // Try to get a fresh QR from WasenderAPI (cache may be stale after ~45s)
      try {
        const { data } = await this.wasender.getSessionQrCode(clinic.whatsappSessionId);
        qrCode = data.qrCode;
        this.qrCache.set(clinicId, qrCode);
      } catch {
        // Fall back to cache if the API call fails
        qrCode = this.qrCache.get(clinicId) ?? null;
      }
    }

    return {
      status: clinic.whatsappStatus,
      phone: clinic.whatsappPhone,
      qrCode,
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
        await this.wasender.deleteSession(clinic.whatsappSessionId);
      } catch {
        this.logger.warn(`Failed to delete WasenderAPI session for clinic ${clinicId}`);
      }
    }

    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: {
        whatsappSessionId: null,
        whatsappApiKey: null,
        whatsappWebhookSecret: null,
        whatsappStatus: WhatsAppStatus.DISCONNECTED,
      },
    });

    this.qrCache.delete(clinicId);
  }

  /**
   * Sends a plain-text WhatsApp message from the clinic's number.
   * Fails silently (logs only) if the clinic is not connected,
   * so callers (appointments, scheduler) don't need to guard the connection state.
   */
  async sendText(clinicId: string, to: string, text: string): Promise<void> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { whatsappApiKey: true, whatsappStatus: true },
    });

    if (!clinic?.whatsappApiKey || clinic.whatsappStatus !== WhatsAppStatus.CONNECTED) {
      this.logger.warn(`Skipping WhatsApp send: clinic ${clinicId} not connected`);
      return;
    }

    try {
      await this.wasender.session(clinic.whatsappApiKey).sendText({ to, text });
    } catch (err) {
      this.logger.error(`Failed to send WhatsApp message to ${to} for clinic ${clinicId}: ${err}`);
    }
  }

  /**
   * Processes an incoming webhook event from WasenderAPI.
   * `sessionId` in the payload is the session's api_key — used to identify the clinic.
   *
   * Events handled:
   * - session.status  → update whatsappStatus
   * - qrcode.updated  → cache fresh QR
   * - messages.received / messages.upsert → delegated to bot module (T-20)
   */
  async handleWebhook(
    payload: WebhookPayload,
    signature: string | undefined,
  ): Promise<void> {
    const clinic = await this.prisma.clinic.findFirst({
      where: { whatsappApiKey: payload.sessionId },
      select: { id: true, whatsappWebhookSecret: true, whatsappStatus: true },
    });

    if (!clinic) {
      this.logger.warn(`Webhook for unknown session: ${payload.sessionId}`);
      return;
    }

    // Verify signature if the clinic has a webhook secret configured
    if (clinic.whatsappWebhookSecret) {
      if (!verifyWebhookSignature(signature, clinic.whatsappWebhookSecret)) {
        this.logger.warn(`Invalid webhook signature for clinic ${clinic.id}`);
        return;
      }
    }

    this.logger.log(`WhatsApp webhook event="${payload.event}" clinic=${clinic.id}`);

    switch (payload.event) {
      case 'session.status':
        await this.handleSessionStatus(clinic.id, payload as SessionStatusPayload);
        break;

      case 'qrcode.updated':
        await this.handleQrCodeUpdated(clinic.id, payload as QrCodeUpdatedPayload);
        break;

      case 'messages.received':
      case 'messages.upsert':
        // Delegated to bot module (T-20) via an injectable message handler
        await this.onIncomingMessage(clinic.id, payload as MessageReceivedPayload | MessageUpsertPayload);
        break;

      default:
        this.logger.debug(`Unhandled webhook event: ${payload.event}`);
    }
  }

  private async handleSessionStatus(clinicId: string, payload: SessionStatusPayload) {
    const { status } = payload.data;

    const whatsappStatus =
      status === 'connected'
        ? WhatsAppStatus.CONNECTED
        : status === 'need_scan'
          ? WhatsAppStatus.PENDING_QR
          : WhatsAppStatus.DISCONNECTED;

    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { whatsappStatus },
    });

    if (whatsappStatus !== WhatsAppStatus.PENDING_QR) {
      this.qrCache.delete(clinicId);
    }
  }

  private async handleQrCodeUpdated(clinicId: string, payload: QrCodeUpdatedPayload) {
    await this.prisma.clinic.update({
      where: { id: clinicId },
      data: { whatsappStatus: WhatsAppStatus.PENDING_QR },
    });
    this.qrCache.set(clinicId, payload.data.qr);
  }

  /**
   * Hook for incoming patient messages. Will be implemented by the bot module (T-20).
   * Overridable so the bot can inject its own handler without changing this service.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async onIncomingMessage(
    _clinicId: string,
    _payload: MessageReceivedPayload | MessageUpsertPayload,
  ): Promise<void> {
    // No-op until bot module is implemented (T-20)
  }
}
