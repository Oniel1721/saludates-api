import { Injectable } from '@nestjs/common';

@Injectable()
export class EnvironmentService {
  private require(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`Missing required environment variable: ${key}`);
    return value;
  }

  get port(): number {
    return parseInt(process.env.PORT ?? '3001', 10);
  }

  get databaseUrl(): string {
    return this.require('DATABASE_URL');
  }

  get jwtSecret(): string {
    return this.require('JWT_SECRET');
  }

  get googleClientId(): string {
    return this.require('GOOGLE_CLIENT_ID');
  }

  get superadminEmails(): string[] {
    return this.require('SUPERADMIN_EMAILS')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  }

  get wasenderApiKey(): string {
    return this.require('WASENDER_API_KEY');
  }

  get anthropicApiKey(): string {
    return this.require('ANTHROPIC_API_KEY');
  }

  /**
   * Public base URL of this API, used to register the WasenderAPI webhook.
   * e.g. "https://api.saludates.com"
   */
  get apiBaseUrl(): string {
    return this.require('API_BASE_URL');
  }
}
