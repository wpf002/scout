-- CreateTable
CREATE TABLE "EntityMerge" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "losingKey" TEXT NOT NULL,
    "winningKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityMerge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MergeDismissal" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "dismissedBy" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntityMerge_caseId_idx" ON "EntityMerge"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityMerge_caseId_losingKey_key" ON "EntityMerge"("caseId", "losingKey");

-- CreateIndex
CREATE INDEX "MergeDismissal_caseId_idx" ON "MergeDismissal"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "MergeDismissal_caseId_suggestionId_key" ON "MergeDismissal"("caseId", "suggestionId");

-- AddForeignKey
ALTER TABLE "EntityMerge" ADD CONSTRAINT "EntityMerge_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeDismissal" ADD CONSTRAINT "MergeDismissal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
