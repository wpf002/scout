-- Dedupe per authorization, not per source alone. Two authorizations
-- collecting the same public fact hold two rows, each naming its own.
-- DropIndex
DROP INDEX "Observation_sourceId_contentHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "Observation_sourceId_authorizationId_contentHash_key" ON "Observation"("sourceId", "authorizationId", "contentHash");

