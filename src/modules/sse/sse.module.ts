import { Module } from '@nestjs/common';
import { SseService } from '@/modules/sse/sse.service';
import { SseController } from '@/modules/sse/sse.controller';

@Module({
  controllers: [SseController],
  providers: [SseService],
  exports: [SseService],
})
export class SseModule {}
