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
    "builderApiKey" TEXT NOT NULL DEFAULT '',
    "builderApiSecret" TEXT NOT NULL DEFAULT '',
    "builderApiPassphrase" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "enabledStrategies" TEXT NOT NULL DEFAULT '["value-betting"]',
    "maxPortfolioExposure" REAL NOT NULL DEFAULT 0.4,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BotProfile" ("apiKey", "apiPassphrase", "apiSecret", "builderApiKey", "builderApiPassphrase", "builderApiSecret", "createdAt", "enabledStrategies", "funderAddress", "id", "isActive", "name", "privateKey", "signatureType", "updatedAt") SELECT "apiKey", "apiPassphrase", "apiSecret", "builderApiKey", "builderApiPassphrase", "builderApiSecret", "createdAt", "enabledStrategies", "funderAddress", "id", "isActive", "name", "privateKey", "signatureType", "updatedAt" FROM "BotProfile";
DROP TABLE "BotProfile";
ALTER TABLE "new_BotProfile" RENAME TO "BotProfile";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
