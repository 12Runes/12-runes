-- AlterTable
ALTER TABLE "Match" ADD COLUMN "season" TEXT;

-- CreateIndex
CREATE INDEX "Match_season_idx" ON "Match"("season");
