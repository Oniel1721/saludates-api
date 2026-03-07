import { Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { PrismaService } from '@/prisma/prisma.service';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';

// Minimal shapes this service needs — avoids tight coupling to Prisma types
interface Patient {
  name: string;
  phone: string;
}

interface Service {
  id: string;
  name: string;
  price: number;
  prerequisites: string | null;
}

interface Appointment {
  startsAt: Date;
  price: number;
  patient: Patient;
  service: Service;
}

// Snapshot of the appointment BEFORE an edit — for MSG-08 diff
export interface AppointmentSnapshot {
  serviceId: string;
  serviceName: string;
  startsAt: Date;
  price: number;
}

@Injectable()
export class WhatsAppMessagesService {
  private readonly logger = new Logger(WhatsAppMessagesService.name);

  constructor(
    private whatsapp: WhatsAppService,
    private prisma: PrismaService,
  ) {}

  // ── Formatting helpers ────────────────────────────────────────────────────────

  private formatDate(date: Date): string {
    // "martes 10 de marzo"
    return format(date, "EEEE d 'de' MMMM", { locale: es });
  }

  private formatTime(date: Date): string {
    // "10:00 AM"
    return format(date, 'h:mm a', { locale: es }).toUpperCase();
  }

  private prerequisitesLine(prerequisites: string | null, prefix = 'Importante'): string {
    return prerequisites ? `\n${prefix}: ${prerequisites}` : '';
  }

  private async getClinicName(clinicId: string): Promise<string> {
    const clinic = await this.prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { name: true },
    });
    return clinic?.name ?? 'el consultorio';
  }

  // ── MSG-01 — Confirmation when secretary creates appointment ──────────────────

  async sendCreatedBySecretary(clinicId: string, appointment: Appointment): Promise<void> {
    try {
      const clinicName = await this.getClinicName(clinicId);
      const { patient, service } = appointment;

      const text = [
        `Hola ${patient.name}, le confirmamos que su cita ha sido agendada en ${clinicName}:`,
        '',
        `Servicio: ${service.name}`,
        `Fecha: ${this.formatDate(appointment.startsAt)}`,
        `Hora: ${this.formatTime(appointment.startsAt)}`,
        `Precio: RD$${appointment.price}`,
        this.prerequisitesLine(service.prerequisites),
        '',
        'Por favor confirme su asistencia respondiendo a este mensaje.',
      ]
        .join('\n')
        .trim();

      await this.whatsapp.sendText(clinicId, patient.phone, text);
    } catch (err) {
      this.logger.error(`MSG-01 failed for clinic ${clinicId}: ${err}`);
    }
  }

  // ── MSG-08 — Notification when secretary edits appointment ────────────────────

  async sendUpdatedBySecretary(
    clinicId: string,
    updated: Appointment,
    previous: AppointmentSnapshot,
  ): Promise<void> {
    try {
      const clinicName = await this.getClinicName(clinicId);
      const { patient, service: newService } = updated;

      const serviceChanged = previous.serviceId !== newService.id;
      const datetimeChanged = previous.startsAt.getTime() !== updated.startsAt.getTime();
      const priceChanged = previous.price !== updated.price;

      const serviceField = serviceChanged
        ? `Servicio: ${previous.serviceName} → Nuevo servicio: ${newService.name}`
        : `Servicio: ${newService.name}`;

      const dateField = datetimeChanged
        ? `Fecha: ${this.formatDate(previous.startsAt)} → Nueva fecha: ${this.formatDate(updated.startsAt)}`
        : `Fecha: ${this.formatDate(updated.startsAt)}`;

      const timeField = datetimeChanged
        ? `Hora: ${this.formatTime(previous.startsAt)} → Nueva hora: ${this.formatTime(updated.startsAt)}`
        : `Hora: ${this.formatTime(updated.startsAt)}`;

      const priceField = priceChanged
        ? `Precio: RD$${previous.price} → Nuevo precio: RD$${updated.price}`
        : `Precio: RD$${updated.price}`;

      const text = [
        `Hola ${patient.name}, le informamos que su cita en ${clinicName} ha sido actualizada:`,
        '',
        serviceField,
        dateField,
        timeField,
        priceField,
        this.prerequisitesLine(newService.prerequisites),
        '',
        'Si tiene alguna duda, no dude en escribirnos.',
      ]
        .join('\n')
        .trim();

      await this.whatsapp.sendText(clinicId, patient.phone, text);
    } catch (err) {
      this.logger.error(`MSG-08 failed for clinic ${clinicId}: ${err}`);
    }
  }

  // ── MSG-09 — Notification when secretary cancels appointment ─────────────────

  async sendCancelledBySecretary(clinicId: string, appointment: Appointment): Promise<void> {
    try {
      const clinicName = await this.getClinicName(clinicId);
      const { patient } = appointment;

      const text = [
        `Hola ${patient.name}, le informamos que su cita en ${clinicName}`,
        `del ${this.formatDate(appointment.startsAt)} a las ${this.formatTime(appointment.startsAt)} ha sido cancelada.`,
        '',
        'Si desea reagendar, estamos a su disposición.',
      ].join('\n');

      await this.whatsapp.sendText(clinicId, patient.phone, text);
    } catch (err) {
      this.logger.error(`MSG-09 failed for clinic ${clinicId}: ${err}`);
    }
  }
}
