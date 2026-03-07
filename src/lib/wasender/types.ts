// ─── Session ──────────────────────────────────────────────────────────────────

export type SessionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'need_scan'
  | 'logged_out'
  | 'expired';

export interface Session {
  id: number;
  name: string;
  phone_number: string;
  status: SessionStatus;
  account_protection: boolean;
  log_messages: boolean;
  read_incoming_messages: boolean;
  webhook_url: string | null;
  webhook_enabled: boolean;
  webhook_events: string[];
  api_key: string;
  webhook_secret: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionParams {
  name: string;
  phone_number: string;
  account_protection: boolean;
  log_messages: boolean;
  read_incoming_messages?: boolean;
  webhook_url?: string;
  webhook_enabled?: boolean;
  webhook_events?: WebhookEventType[];
  auto_reject_calls?: boolean;
  ignore_groups?: boolean;
  ignore_channels?: boolean;
  ignore_broadcasts?: boolean;
}

export interface ConnectResult {
  status: 'NEED_SCAN' | 'INITIALIZED';
  qrCode?: string;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface SendTextParams {
  /** Recipient phone in E.164 format (e.g. "18091234567"), Group JID, or Channel JID */
  to: string;
  text: string;
}

export interface SendMessageResult {
  msgId: number;
  jid: string;
  status: string;
}

// ─── Webhook events ───────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'messages.received'
  | 'messages.upsert'
  | 'messages.update'
  | 'messages.delete'
  | 'message.reaction'
  | 'group.upsert'
  | 'group.participants.update'
  | 'group.update'
  | 'group.message.received'
  | 'contact.upsert'
  | 'contact.update'
  | 'chat.upsert'
  | 'chat.update'
  | 'chat.delete'
  | 'session.status'
  | 'qrcode.updated'
  | 'newsletter.message.received'
  | 'call.received'
  | 'poll.results';

export interface MessageKey {
  id: string;
  fromMe: boolean;
  remoteJid: string;
  senderPn?: string;
  cleanedSenderPn?: string;
  senderLid?: string;
  addressingMode?: string;
}

export interface IncomingMessage {
  key: MessageKey;
  /** Plain text body of the message */
  messageBody: string;
  message: {
    conversation?: string;
    imageMessage?: Record<string, unknown>;
    videoMessage?: Record<string, unknown>;
    audioMessage?: Record<string, unknown>;
    documentMessage?: Record<string, unknown>;
    stickerMessage?: Record<string, unknown>;
    locationMessage?: Record<string, unknown>;
    contactMessage?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

// Discriminated union of all webhook payloads
export type WebhookPayload =
  | SessionStatusPayload
  | QrCodeUpdatedPayload
  | MessageReceivedPayload
  | MessageUpsertPayload
  | UnknownWebhookPayload;

export interface SessionStatusPayload {
  event: 'session.status';
  /** The session's api_key — use this to identify which session sent the event */
  sessionId: string;
  data: { status: SessionStatus };
}

export interface QrCodeUpdatedPayload {
  event: 'qrcode.updated';
  /** The session's api_key */
  sessionId: string;
  data: { qr: string };
}

export interface MessageReceivedPayload {
  event: 'messages.received';
  /** The session's api_key */
  sessionId: string;
  timestamp: number;
  data: {
    messages: IncomingMessage;
  };
}

export interface MessageUpsertPayload {
  event: 'messages.upsert';
  /** The session's api_key */
  sessionId: string;
  timestamp: number;
  data: {
    messages: IncomingMessage;
  };
}

export interface UnknownWebhookPayload {
  event: string;
  sessionId: string;
  [key: string]: unknown;
}

// ─── API response wrapper ─────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data: T;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class WasenderError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(`WasenderAPI ${method} ${path} → ${statusCode}: ${responseBody}`);
    this.name = 'WasenderError';
  }
}
