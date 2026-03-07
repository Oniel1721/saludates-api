import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { WhatsAppService } from '@/modules/whatsapp/whatsapp.service';
import { ConnectWhatsAppDto } from '@/modules/whatsapp/dto/connect-whatsapp.dto';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics/:clinicId/whatsapp')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class WhatsAppController {
  constructor(private whatsapp: WhatsAppService) {}

  /**
   * POST /clinics/:clinicId/whatsapp/connect
   * Starts a new WasenderAPI session for the clinic.
   * Returns a base64 QR code the user must scan with WhatsApp.
   */
  @Post('connect')
  connect(@Param('clinicId') clinicId: string, @Body() dto: ConnectWhatsAppDto) {
    return this.whatsapp.connect(clinicId, dto.phone);
  }

  /**
   * GET /clinics/:clinicId/whatsapp/status
   * Returns { status, phone, qrCode? }.
   * qrCode is only present when status is PENDING_QR.
   */
  @Get('status')
  getStatus(@Param('clinicId') clinicId: string) {
    return this.whatsapp.getStatus(clinicId);
  }

  /**
   * DELETE /clinics/:clinicId/whatsapp/disconnect
   * Deletes the WasenderAPI session and marks the clinic as disconnected.
   */
  @Delete('disconnect')
  disconnect(@Param('clinicId') clinicId: string) {
    return this.whatsapp.disconnect(clinicId);
  }
}
