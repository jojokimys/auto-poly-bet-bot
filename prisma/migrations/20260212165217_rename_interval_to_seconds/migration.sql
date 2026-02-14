/*
  Warnings:

  - You are about to drop the column `scanIntervalMinutes` on the `BotSettings` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BotSettings" (
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
    "scanIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BotSettings" ("apiKey", "apiPassphrase", "apiSecret", "autoBettingEnabled", "funderAddress", "id", "maxBetAmount", "maxSpread", "minLiquidity", "minVolume", "privateKey", "updatedAt") SELECT "apiKey", "apiPassphrase", "apiSecret", "autoBettingEnabled", "funderAddress", "id", "maxBetAmount", "maxSpread", "minLiquidity", "minVolume", "privateKey", "updatedAt" FROM "BotSettings";
DROP TABLE "BotSettings";
ALTER TABLE "new_BotSettings" RENAME TO "BotSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
