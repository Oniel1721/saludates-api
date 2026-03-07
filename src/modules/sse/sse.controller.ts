import { Controller, MessageEvent, Param, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';
import { SseService } from '@/modules/sse/sse.service';

@Controller('clinics/:clinicId/events')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class SseController {
  constructor(private sse: SseService) {}

  @Sse()
  stream(@Param('clinicId') clinicId: string): Observable<MessageEvent> {
    return this.sse.subscribe(clinicId);
  }
}
