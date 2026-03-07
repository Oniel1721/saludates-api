import { Module } from '@nestjs/common';
import { NotificationsController } from '@/modules/notifications/notifications.controller';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { SseModule } from '@/modules/sse/sse.module';

@Module({
  imports: [SseModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
