import { Body, Controller, Post } from '@nestjs/common';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';

/**
 * Global webhook endpoint that WasenderAPI calls for all events
 * (QR updates, connection status changes, incoming messages).
 * No auth guard — WasenderAPI does not send JWT tokens.
 */
@Controller('whatsapp')
export class WhatsAppWebhookController {
  constructor(private whatsapp: WhatsAppService) {}

  @Post('webhook')
  handleWebhook(@Body() payload: Record<string, unknown>) {
    return this.whatsapp.handleWebhook(payload as any);
  }
}
