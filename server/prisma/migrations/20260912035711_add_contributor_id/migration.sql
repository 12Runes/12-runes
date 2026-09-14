-- AlterTable
ALTER TABLE "Match" ADD COLUMN "contributorId" TEXT;

-- CreateIndex
CREATE INDEX "Match_contributorId_idx" ON "Match"("contributorId");
