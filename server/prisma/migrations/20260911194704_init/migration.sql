-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameName" TEXT NOT NULL DEFAULT 'Riftbound',
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "result" TEXT NOT NULL,
    "turnCount" INTEGER,
    "localPlayerId" TEXT,
    "localPseudo" TEXT,
    "opponentPlayerId" TEXT,
    "opponentPseudo" TEXT,
    "localLegendId" TEXT,
    "localLegendName" TEXT,
    "opponentLegendId" TEXT,
    "opponentLegendName" TEXT,
    "localDeck" TEXT,
    "opponentDeck" TEXT,
    "events" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Match_localLegendName_idx" ON "Match"("localLegendName");

-- CreateIndex
CREATE INDEX "Match_opponentLegendName_idx" ON "Match"("opponentLegendName");

-- CreateIndex
CREATE INDEX "Match_result_idx" ON "Match"("result");
