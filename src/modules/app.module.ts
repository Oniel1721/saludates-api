import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { EnvironmentModule } from '@/config/environment.module';
import { ClinicsModule } from '@/modules/clinics/clinics.module';
import { ServicesModule } from '@/modules/services/services.module';

@Module({
  imports: [EnvironmentModule, PrismaModule, AuthModule, ClinicsModule, ServicesModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
