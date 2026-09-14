-- AlterTable
ALTER TABLE "Match" ADD COLUMN "matchFingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Match_matchFingerprint_key" ON "Match"("matchFingerprint");
