-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BotProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "funderAddress" TEXT NOT NULL DEFAULT '',
    "signatureType" INTEGER NOT NULL DEFAULT 2,
    "apiKey" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,
    "apiPassphrase" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "strategy" TEXT NOT NULL DEFAULT 'value-betting',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BotProfile" ("apiKey", "apiPassphrase", "apiSecret", "createdAt", "funderAddress", "id", "isActive", "name", "privateKey", "strategy", "updatedAt") SELECT "apiKey", "apiPassphrase", "apiSecret", "createdAt", "funderAddress", "id", "isActive", "name", "privateKey", "strategy", "updatedAt" FROM "BotProfile";
DROP TABLE "BotProfile";
ALTER TABLE "new_BotProfile" RENAME TO "BotProfile";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
