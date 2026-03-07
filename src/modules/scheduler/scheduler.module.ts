import { Module } from '@nestjs/common';
import { SchedulerService } from '@/modules/scheduler/scheduler.service';
import { BotModule } from '@/modules/bot/bot.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

@Module({
  imports: [BotModule, NotificationsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
