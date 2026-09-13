-- How an edge was derived, and its identity across derivation runs.
-- DropIndex
DROP INDEX "EntityEdge_authorizationId_idx";

-- AlterTable
ALTER TABLE "EntityEdge" ADD COLUMN     "basis" TEXT NOT NULL DEFAULT 'asserted',
ADD COLUMN     "fingerprint" TEXT;

-- CreateIndex
CREATE INDEX "EntityEdge_authorizationId_supersededAt_idx" ON "EntityEdge"("authorizationId", "supersededAt");

-- CreateIndex
CREATE INDEX "EntityEdge_authorizationId_fingerprint_idx" ON "EntityEdge"("authorizationId", "fingerprint");

