/*
  Warnings:

  - The `whatsapp_session_id` column on the `clinics` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "clinics" ADD COLUMN     "whatsapp_api_key" TEXT,
ADD COLUMN     "whatsapp_webhook_secret" TEXT,
DROP COLUMN "whatsapp_session_id",
ADD COLUMN     "whatsapp_session_id" INTEGER;
