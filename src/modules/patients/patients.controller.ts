import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PatientsService } from '@/modules/patients/patients.service';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { ClinicGuard } from '@/modules/auth/guards/clinic.guard';

@Controller('clinics/:clinicId/patients')
@UseGuards(JwtAuthGuard, ClinicGuard)
export class PatientsController {
  constructor(private patients: PatientsService) {}

  // T-17: searchable contact list (?search=name_or_phone)
  @Get()
  findAll(@Param('clinicId') clinicId: string, @Query('search') search?: string) {
    return this.patients.findAll(clinicId, search);
  }

  // T-18: patient profile with appointment history
  @Get(':patientId')
  findOne(@Param('clinicId') clinicId: string, @Param('patientId') patientId: string) {
    return this.patients.findOne(clinicId, patientId);
  }
}
