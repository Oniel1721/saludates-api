import {
  ApiResponse,
  ConnectResult,
  CreateSessionParams,
  SendMessageResult,
  SendTextParams,
  Session,
  SessionStatus,
  WasenderError,
} from '@/lib/wasender/types';

const BASE_URL = 'https://www.wasenderapi.com/api';

// ─── Base HTTP ────────────────────────────────────────────────────────────────

async function request<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WasenderError(method, path, res.status, text);
  }

  return res.json() as Promise<T>;
}

// ─── WasenderClient — personal access token ───────────────────────────────────
//
// Use this for session management (create, connect, delete, get QR).
// Auth: WASENDER_API_KEY (personal access token from settings).

export class WasenderClient {
  constructor(private readonly personalToken: string) {}

  private req<T>(method: string, path: string, body?: unknown) {
    return request<T>(method, path, this.personalToken, body);
  }

  // Sessions ──────────────────────────────────────────────────────────────────

  /** List all WhatsApp sessions in the account. */
  listSessions(): Promise<ApiResponse<Session[]>> {
    return this.req('GET', '/whatsapp-sessions');
  }

  /**
   * Create a new WhatsApp session.
   * The response includes `api_key` and `webhook_secret` — store both.
   */
  createSession(params: CreateSessionParams): Promise<ApiResponse<Session>> {
    return this.req('POST', '/whatsapp-sessions', params);
  }

  /** Get a single session by its numeric ID. */
  getSession(id: number): Promise<ApiResponse<Session>> {
    return this.req('GET', `/whatsapp-sessions/${id}`);
  }

  /** Update session settings (webhook URL, events, etc.). */
  updateSession(id: number, params: Partial<CreateSessionParams>): Promise<ApiResponse<Session>> {
    return this.req('PUT', `/whatsapp-sessions/${id}`, params);
  }

  /** Delete a session permanently. */
  deleteSession(id: number): Promise<ApiResponse<void>> {
    return this.req('DELETE', `/whatsapp-sessions/${id}`);
  }

  /**
   * Initiate the WhatsApp connection for a session.
   * Returns a QR code string when `status === "NEED_SCAN"`.
   * Pass the QR string through a QR code library to render the image.
   */
  connectSession(id: number): Promise<ApiResponse<ConnectResult>> {
    return this.req('POST', `/whatsapp-sessions/${id}/connect`);
  }

  /** Disconnect a session without deleting it. */
  disconnectSession(id: number): Promise<ApiResponse<void>> {
    return this.req('POST', `/whatsapp-sessions/${id}/disconnect`);
  }

  /** Restart a session. */
  restartSession(id: number): Promise<ApiResponse<void>> {
    return this.req('POST', `/whatsapp-sessions/${id}/restart`);
  }

  /**
   * Get a fresh QR code string.
   * Call this when the initial QR expires (~45 seconds) and the user hasn't scanned yet.
   */
  getSessionQrCode(id: number): Promise<ApiResponse<{ qrCode: string }>> {
    return this.req('GET', `/whatsapp-sessions/${id}/qrcode`);
  }

  /** Create a session-scoped client for sending messages and checking status. */
  session(apiKey: string): WasenderSessionClient {
    return new WasenderSessionClient(apiKey);
  }
}

// ─── WasenderSessionClient — session api_key ──────────────────────────────────
//
// Use this for per-session operations (send messages, get status).
// Auth: the session's `api_key` returned when the session was created.

export class WasenderSessionClient {
  constructor(private readonly apiKey: string) {}

  private req<T>(method: string, path: string, body?: unknown) {
    return request<T>(method, path, this.apiKey, body);
  }

  // Status ────────────────────────────────────────────────────────────────────

  /** Get the current connection status of this session. */
  getStatus(): Promise<{ status: SessionStatus }> {
    return this.req('GET', '/status');
  }

  // Messages ──────────────────────────────────────────────────────────────────

  /**
   * Send a plain text message.
   * `to` must be in E.164 format (e.g. "18091234567") for individual chats.
   */
  sendText(params: SendTextParams): Promise<ApiResponse<SendMessageResult>> {
    return this.req('POST', '/send-message', params);
  }
}

// ─── Webhook verification ─────────────────────────────────────────────────────

/**
 * Verify that an incoming webhook request originated from WasenderAPI.
 * Compare the `X-Webhook-Signature` header against the stored webhook_secret.
 *
 * @returns true if valid, false if signature doesn't match or is missing.
 */
export function verifyWebhookSignature(
  signature: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signature) return false;
  return signature === webhookSecret;
}
