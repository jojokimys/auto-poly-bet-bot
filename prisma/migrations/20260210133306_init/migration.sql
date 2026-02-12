-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conditionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "liquidity" REAL NOT NULL DEFAULT 0,
    "volume" REAL NOT NULL DEFAULT 0,
    "image" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "price" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "Outcome_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT,
    "marketId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "size" REAL NOT NULL,
    "sizeMatched" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "type" TEXT NOT NULL DEFAULT 'LIMIT',
    "outcome" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT,
    "orderId" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "size" REAL NOT NULL,
    "fee" REAL NOT NULL DEFAULT 0,
    "matchTime" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trade_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "privateKey" TEXT NOT NULL DEFAULT '',
    "funderAddress" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "apiSecret" TEXT NOT NULL DEFAULT '',
    "apiPassphrase" TEXT NOT NULL DEFAULT '',
    "maxBetAmount" REAL NOT NULL DEFAULT 10,
    "minLiquidity" REAL NOT NULL DEFAULT 1000,
    "minVolume" REAL NOT NULL DEFAULT 5000,
    "maxSpread" REAL NOT NULL DEFAULT 0.05,
    "autoBettingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scanIntervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "marketId" TEXT NOT NULL,
    "yesPrice" REAL NOT NULL,
    "noPrice" REAL NOT NULL,
    "volume24hr" REAL NOT NULL DEFAULT 0,
    "spread" REAL NOT NULL DEFAULT 0,
    "liquidity" REAL NOT NULL DEFAULT 0,
    "snapshotAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketSnapshot_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Market_conditionId_key" ON "Market"("conditionId");

-- CreateIndex
CREATE UNIQUE INDEX "Outcome_marketId_name_key" ON "Outcome"("marketId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Order_externalId_key" ON "Order"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_externalId_key" ON "Trade"("externalId");

-- CreateIndex
CREATE INDEX "MarketSnapshot_marketId_snapshotAt_idx" ON "MarketSnapshot"("marketId", "snapshotAt");
