import { Injectable, MessageEvent } from '@nestjs/common';
import { Observable, Subject, finalize } from 'rxjs';

/**
 * Manages SSE connections per clinic.
 * NotificationsService calls emit() after every notification.create().
 */
@Injectable()
export class SseService {
  private readonly subjects = new Map<string, Set<Subject<MessageEvent>>>();

  /**
   * Returns an Observable that streams events to the connected client.
   * Automatically cleans up when the client disconnects.
   */
  subscribe(clinicId: string): Observable<MessageEvent> {
    const subject = new Subject<MessageEvent>();

    if (!this.subjects.has(clinicId)) {
      this.subjects.set(clinicId, new Set());
    }
    this.subjects.get(clinicId)!.add(subject);

    return subject.asObservable().pipe(
      finalize(() => {
        this.subjects.get(clinicId)?.delete(subject);
        if (this.subjects.get(clinicId)?.size === 0) {
          this.subjects.delete(clinicId);
        }
      }),
    );
  }

  /**
   * Pushes an event to all clients connected to the given clinic.
   */
  emit(clinicId: string, data: Record<string, unknown>): void {
    const clinicSubjects = this.subjects.get(clinicId);
    if (!clinicSubjects || clinicSubjects.size === 0) return;

    const event: MessageEvent = { data };
    for (const subject of clinicSubjects) {
      subject.next(event);
    }
  }
}
