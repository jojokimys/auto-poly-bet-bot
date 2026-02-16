-- AlterTable: BotProfile - rename strategy → enabledStrategies
ALTER TABLE "BotProfile" ADD COLUMN "enabledStrategies" TEXT NOT NULL DEFAULT '["value-betting"]';

-- Migrate existing strategy values to JSON array format
UPDATE "BotProfile" SET "enabledStrategies" = '["' || "strategy" || '"]' WHERE "strategy" IS NOT NULL AND "strategy" != '';

-- Drop old column
ALTER TABLE "BotProfile" DROP COLUMN "strategy";

-- AlterTable: AiDecision - add strategy column
ALTER TABLE "AiDecision" ADD COLUMN "strategy" TEXT;
