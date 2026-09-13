-- The entity kind an observation is about, from its collector. Resolution
-- runs per kind.
-- AlterTable
ALTER TABLE "Observation" ADD COLUMN     "entityKind" "FusionEntityKind";

-- CreateIndex
CREATE INDEX "Observation_authorizationId_entityKind_idx" ON "Observation"("authorizationId", "entityKind");

