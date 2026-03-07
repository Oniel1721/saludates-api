import { Module } from '@nestjs/common';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { WhatsAppMessagesService } from '@/modules/whatsapp/whatsapp-messages.service';
import { WhatsAppController } from '@/modules/whatsapp/whatsapp.controller';
import { WhatsAppWebhookController } from '@/modules/whatsapp/whatsapp-webhook.controller';

@Module({
  controllers: [WhatsAppController, WhatsAppWebhookController],
  providers: [WhatsAppService, WhatsAppMessagesService],
  exports: [WhatsAppService, WhatsAppMessagesService],
})
export class WhatsAppModule {}
