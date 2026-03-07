import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AppointmentsService } from '@/modules/appointments/appointments.service';
import { CreateAppointmentDto } from '@/modules/appointments/dto/create-appointment.dto';
import { UpdateAppointmentDto } from '@/modules/appointments/dto/update-appointment.dto';
import { CancelAppointmentDto } from '@/modules/appointments/dto/cancel-appointment.dto';
import { MarkResultDto } from '@/modules/appointments/dto/mark-result.dto';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics/:clinicId/appointments')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class AppointmentsController {
  constructor(private appointments: AppointmentsService) {}

  // Calendar view (T-10): ?from=YYYY-MM-DD&to=YYYY-MM-DD
  @Get()
  findAll(
    @Param('clinicId') clinicId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.appointments.findAll(clinicId, from, to);
  }

  @Get(':appointmentId')
  findOne(
    @Param('clinicId') clinicId: string,
    @Param('appointmentId') appointmentId: string,
  ) {
    return this.appointments.findOne(clinicId, appointmentId);
  }

  // T-12
  @Post()
  create(@Param('clinicId') clinicId: string, @Body() dto: CreateAppointmentDto) {
    return this.appointments.create(clinicId, dto);
  }

  // T-13
  @Patch(':appointmentId')
  update(
    @Param('clinicId') clinicId: string,
    @Param('appointmentId') appointmentId: string,
    @Body() dto: UpdateAppointmentDto,
  ) {
    return this.appointments.update(clinicId, appointmentId, dto);
  }

  // T-14
  @Post(':appointmentId/cancel')
  cancel(
    @Param('clinicId') clinicId: string,
    @Param('appointmentId') appointmentId: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    return this.appointments.cancel(clinicId, appointmentId, dto);
  }

  // T-15
  @Post(':appointmentId/result')
  markResult(
    @Param('clinicId') clinicId: string,
    @Param('appointmentId') appointmentId: string,
    @Body() dto: MarkResultDto,
  ) {
    return this.appointments.markResult(clinicId, appointmentId, dto);
  }
}
