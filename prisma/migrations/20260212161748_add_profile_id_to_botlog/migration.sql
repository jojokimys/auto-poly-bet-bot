-- AlterTable
ALTER TABLE "BotLog" ADD COLUMN "profileId" TEXT;

-- CreateIndex
CREATE INDEX "BotLog_profileId_idx" ON "BotLog"("profileId");
