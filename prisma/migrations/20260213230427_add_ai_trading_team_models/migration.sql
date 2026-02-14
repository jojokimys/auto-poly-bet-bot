-- CreateTable
CREATE TABLE "ScalperPosition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "entryTime" DATETIME NOT NULL,
    "size" REAL NOT NULL,
    "targetPrice" REAL NOT NULL,
    "stopPrice" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" DATETIME,
    "closeReason" TEXT
);

-- CreateTable
CREATE TABLE "AiSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "cycleCount" INTEGER NOT NULL DEFAULT 0,
    "totalPnl" REAL NOT NULL DEFAULT 0,
    "summary" TEXT
);

-- CreateTable
CREATE TABLE "AiDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "conditionId" TEXT,
    "action" TEXT,
    "tokenId" TEXT,
    "outcome" TEXT,
    "price" REAL,
    "size" REAL,
    "reason" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "result" TEXT,
    "pnl" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiDecision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AiSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiLearning" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "insight" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ScalperPosition_profileId_status_idx" ON "ScalperPosition"("profileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScalperPosition_profileId_conditionId_key" ON "ScalperPosition"("profileId", "conditionId");

-- CreateIndex
CREATE INDEX "AiSession_profileId_idx" ON "AiSession"("profileId");

-- CreateIndex
CREATE INDEX "AiDecision_profileId_createdAt_idx" ON "AiDecision"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "AiDecision_sessionId_idx" ON "AiDecision"("sessionId");

-- CreateIndex
CREATE INDEX "AiLearning_profileId_category_idx" ON "AiLearning"("profileId", "category");
