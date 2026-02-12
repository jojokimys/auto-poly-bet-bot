-- CreateTable
CREATE TABLE "BotLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BotLog_createdAt_idx" ON "BotLog"("createdAt");

-- CreateIndex
CREATE INDEX "BotLog_event_idx" ON "BotLog"("event");
