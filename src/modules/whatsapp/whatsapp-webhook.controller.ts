import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import type { WebhookPayload } from '@/lib/wasender';

/**
 * Global webhook endpoint that WasenderAPI calls for all events.
 * No auth guard — requests are verified via X-Webhook-Signature instead.
 * Always responds 200 quickly; processing is async.
 */
@Controller('whatsapp')
export class WhatsAppWebhookController {
  constructor(private whatsapp: WhatsAppService) {}

  @Post('webhook')
  @HttpCode(200)
  handleWebhook(
    @Body() payload: WebhookPayload,
    @Headers('x-webhook-signature') signature: string | undefined,
  ) {
    // Fire-and-forget — WasenderAPI expects a fast 200 response
    void this.whatsapp.handleWebhook(payload, signature);
    return { received: true };
  }
}
