import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { EnvironmentModule } from '@/config/environment.module';
import { ClinicsModule } from '@/modules/clinics/clinics.module';
import { ServicesModule } from '@/modules/services/services.module';
import { AvailabilityModule } from '@/modules/availability/availability.module';

@Module({
  imports: [EnvironmentModule, PrismaModule, AuthModule, ClinicsModule, ServicesModule, AvailabilityModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
