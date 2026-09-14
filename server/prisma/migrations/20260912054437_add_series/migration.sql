-- AlterTable
ALTER TABLE "Match" ADD COLUMN "gameNumber" INTEGER;
ALTER TABLE "Match" ADD COLUMN "seriesId" TEXT;

-- CreateIndex
CREATE INDEX "Match_seriesId_idx" ON "Match"("seriesId");
