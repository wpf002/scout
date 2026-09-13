-- v2 fusion: authorization, observations with provenance, resolution,
-- the temporal graph, gallery-restricted biometrics, read audit.
--
-- PostGIS first: the Observation.geom column below is a geography type and
-- cannot be created without it. On Railway this runs against the PostGIS
-- template image; locally against docker-compose.v2.yml. Both already have
-- the extension available; this makes it active in this database.
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "SourceClass" AS ENUM ('OWNED', 'LICENSED', 'PUBLIC_RECORD', 'OPEN_WEB', 'BROKER', 'SENSOR', 'SATELLITE', 'FIRST_PARTY');

-- CreateEnum
CREATE TYPE "ActionClass" AS ENUM ('COLLECT', 'RESOLVE', 'READ_GRAPH', 'BIOMETRIC_COMPARE', 'PROPOSE', 'APPROVE_CONSEQUENTIAL');

-- CreateEnum
CREATE TYPE "IdentifierKind" AS ENUM ('EMAIL', 'PHONE', 'HANDLE', 'DEVICE_ID', 'PLATE', 'TAIL_NUMBER', 'ICAO_HEX', 'MMSI', 'IMO', 'HASH', 'DOCUMENT_NO', 'NAME', 'ADDRESS', 'DOMAIN', 'IP', 'URL');

-- CreateEnum
CREATE TYPE "FusionEntityKind" AS ENUM ('PERSON', 'ORG', 'VESSEL', 'AIRCRAFT', 'VEHICLE', 'ACCOUNT', 'LOCATION', 'DEVICE', 'INFRASTRUCTURE');

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('RESOLVED', 'PROVISIONAL', 'UNRESOLVED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "MemberAddedBy" AS ENUM ('SYSTEM', 'ANALYST');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "MatchOutcome" AS ENUM ('MATCH', 'NON_MATCH', 'REVIEW', 'INDETERMINATE');

-- CreateEnum
CREATE TYPE "EdgeRelation" AS ENUM ('CO_LOCATED', 'COMMUNICATED_WITH', 'OWNS', 'OPERATES', 'MEMBER_OF', 'TRANSACTED_WITH', 'SAME_DEVICE', 'ASSOCIATED_WITH');

-- CreateEnum
CREATE TYPE "LawfulBasis" AS ENUM ('CONSENT', 'COURT_ORDER', 'STATUTORY_AUTHORITY', 'EMPLOYMENT', 'CONTRACT');

-- CreateEnum
CREATE TYPE "Modality" AS ENUM ('FACE', 'VOICE');

-- CreateEnum
CREATE TYPE "ComparisonDecision" AS ENUM ('MATCH', 'NO_MATCH', 'INDETERMINATE');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "authorizationId" TEXT;

-- CreateTable
CREATE TABLE "Authorization" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "boundary" JSONB NOT NULL,
    "sourceClasses" "SourceClass"[],
    "actionClasses" "ActionClass"[],
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'local',

    CONSTRAINT "Authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "class" "SourceClass" NOT NULL,
    "licensingTerms" TEXT NOT NULL,
    "tosUrl" TEXT,
    "refreshCadenceSeconds" INTEGER NOT NULL,
    "spatialResolutionMeters" INTEGER,
    "temporalLagSeconds" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "credentialsRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "normalizedPayload" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "geom" geography(Point,4326),
    "confidenceBp" INTEGER,
    "indeterminate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Identifier" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "kind" "IdentifierKind" NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "normalizationVersion" TEXT NOT NULL,

    CONSTRAINT "Identifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "kind" "FusionEntityKind" NOT NULL,
    "canonicalLabel" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastResolvedAt" TIMESTAMP(3),
    "resolutionRunId" TEXT,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityMember" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "scoreBp" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" "MemberAddedBy" NOT NULL,
    "addedByActor" TEXT NOT NULL DEFAULT 'system',
    "supersededAt" TIMESTAMP(3),
    "supersededBy" TEXT,

    CONSTRAINT "EntityMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionRun" (
    "id" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "modelVersion" TEXT NOT NULL,
    "normalizationVersion" TEXT NOT NULL,
    "matchThresholdBp" INTEGER NOT NULL,
    "reviewThresholdBp" INTEGER NOT NULL,
    "pairsEvaluated" INTEGER NOT NULL DEFAULT 0,
    "triggeredBy" TEXT NOT NULL DEFAULT 'local',
    "errorMessage" TEXT,

    CONSTRAINT "ResolutionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchDecision" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "leftObservationId" TEXT NOT NULL,
    "rightObservationId" TEXT NOT NULL,
    "scoreBp" INTEGER,
    "decision" "MatchOutcome" NOT NULL,
    "featureVector" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "blockingKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Adjudication" (
    "id" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "leftObservationId" TEXT NOT NULL,
    "rightObservationId" TEXT NOT NULL,
    "decision" "MatchOutcome" NOT NULL,
    "adjudicatedBy" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Adjudication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityEdge" (
    "id" TEXT NOT NULL,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "relation" "EdgeRelation" NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "confidenceBp" INTEGER NOT NULL,
    "evidenceObservationIds" TEXT[],
    "authorizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "supersededAt" TIMESTAMP(3),
    "supersededBy" TEXT,

    CONSTRAINT "EntityEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gallery" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "custodianOrg" TEXT NOT NULL,
    "lawfulBasis" "LawfulBasis" NOT NULL,
    "lawfulBasisDocumentRef" TEXT NOT NULL,
    "reviewDueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'local',

    CONSTRAINT "Gallery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GalleryEnrollment" (
    "id" TEXT NOT NULL,
    "galleryId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "modality" "Modality" NOT NULL,
    "templateRef" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolledBy" TEXT NOT NULL,
    "lawfulBasisDocumentRef" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "GalleryEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BiometricComparison" (
    "id" TEXT NOT NULL,
    "probeHash" TEXT NOT NULL,
    "galleryId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "modality" "Modality" NOT NULL,
    "topMatches" JSONB NOT NULL,
    "thresholdBp" INTEGER NOT NULL,
    "decision" "ComparisonDecision" NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiometricComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "authorizationId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetIds" TEXT[],
    "queryText" TEXT,
    "resultCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Authorization_reference_idx" ON "Authorization"("reference");

-- CreateIndex
CREATE INDEX "Authorization_validUntil_revokedAt_idx" ON "Authorization"("validUntil", "revokedAt");

-- CreateIndex
CREATE INDEX "Observation_authorizationId_observedAt_idx" ON "Observation"("authorizationId", "observedAt");

-- CreateIndex
CREATE INDEX "Observation_observedAt_idx" ON "Observation"("observedAt");

-- CreateIndex
CREATE INDEX "Observation_caseId_idx" ON "Observation"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "Observation_sourceId_contentHash_key" ON "Observation"("sourceId", "contentHash");

-- CreateIndex
CREATE INDEX "Identifier_observationId_idx" ON "Identifier"("observationId");

-- CreateIndex
CREATE INDEX "Identifier_kind_normalizedValue_idx" ON "Identifier"("kind", "normalizedValue");

-- CreateIndex
CREATE INDEX "Entity_kind_status_idx" ON "Entity"("kind", "status");

-- CreateIndex
CREATE INDEX "Entity_resolutionRunId_idx" ON "Entity"("resolutionRunId");

-- CreateIndex
CREATE INDEX "EntityMember_entityId_supersededAt_idx" ON "EntityMember"("entityId", "supersededAt");

-- CreateIndex
CREATE INDEX "EntityMember_observationId_idx" ON "EntityMember"("observationId");

-- CreateIndex
CREATE INDEX "ResolutionRun_authorizationId_startedAt_idx" ON "ResolutionRun"("authorizationId", "startedAt");

-- CreateIndex
CREATE INDEX "MatchDecision_decision_createdAt_idx" ON "MatchDecision"("decision", "createdAt");

-- CreateIndex
CREATE INDEX "MatchDecision_leftObservationId_idx" ON "MatchDecision"("leftObservationId");

-- CreateIndex
CREATE INDEX "MatchDecision_rightObservationId_idx" ON "MatchDecision"("rightObservationId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchDecision_runId_leftObservationId_rightObservationId_key" ON "MatchDecision"("runId", "leftObservationId", "rightObservationId");

-- CreateIndex
CREATE INDEX "Adjudication_pairKey_createdAt_idx" ON "Adjudication"("pairKey", "createdAt");

-- CreateIndex
CREATE INDEX "EntityEdge_fromEntityId_validFrom_idx" ON "EntityEdge"("fromEntityId", "validFrom");

-- CreateIndex
CREATE INDEX "EntityEdge_toEntityId_validFrom_idx" ON "EntityEdge"("toEntityId", "validFrom");

-- CreateIndex
CREATE INDEX "EntityEdge_authorizationId_idx" ON "EntityEdge"("authorizationId");

-- CreateIndex
CREATE INDEX "EntityEdge_createdAt_idx" ON "EntityEdge"("createdAt");

-- CreateIndex
CREATE INDEX "Gallery_reviewDueAt_idx" ON "Gallery"("reviewDueAt");

-- CreateIndex
CREATE INDEX "GalleryEnrollment_galleryId_modality_expiresAt_idx" ON "GalleryEnrollment"("galleryId", "modality", "expiresAt");

-- CreateIndex
CREATE INDEX "GalleryEnrollment_entityId_idx" ON "GalleryEnrollment"("entityId");

-- CreateIndex
CREATE INDEX "BiometricComparison_galleryId_requestedAt_idx" ON "BiometricComparison"("galleryId", "requestedAt");

-- CreateIndex
CREATE INDEX "BiometricComparison_authorizationId_requestedAt_idx" ON "BiometricComparison"("authorizationId", "requestedAt");

-- CreateIndex
CREATE INDEX "AccessLog_authorizationId_createdAt_idx" ON "AccessLog"("authorizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AccessLog_actor_createdAt_idx" ON "AccessLog"("actor", "createdAt");

-- CreateIndex
CREATE INDEX "AccessLog_targetType_createdAt_idx" ON "AccessLog"("targetType", "createdAt");

-- CreateIndex
CREATE INDEX "Case_authorizationId_idx" ON "Case"("authorizationId");

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "Authorization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "CollectionSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "Authorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Identifier" ADD CONSTRAINT "Identifier_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "Observation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_resolutionRunId_fkey" FOREIGN KEY ("resolutionRunId") REFERENCES "ResolutionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMember" ADD CONSTRAINT "EntityMember_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMember" ADD CONSTRAINT "EntityMember_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "Observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionRun" ADD CONSTRAINT "ResolutionRun_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "Authorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResolutionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityEdge" ADD CONSTRAINT "EntityEdge_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityEdge" ADD CONSTRAINT "EntityEdge_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityEdge" ADD CONSTRAINT "EntityEdge_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "Authorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GalleryEnrollment" ADD CONSTRAINT "GalleryEnrollment_galleryId_fkey" FOREIGN KEY ("galleryId") REFERENCES "Gallery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GalleryEnrollment" ADD CONSTRAINT "GalleryEnrollment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BiometricComparison" ADD CONSTRAINT "BiometricComparison_galleryId_fkey" FOREIGN KEY ("galleryId") REFERENCES "Gallery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BiometricComparison" ADD CONSTRAINT "BiometricComparison_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "Authorization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── spatial index ──────────────────────────────────────────────────────────
CREATE INDEX "Observation_geom_idx" ON "Observation" USING GIST ("geom");

-- ── an edge without evidence is not an edge ───────────────────────────────
ALTER TABLE "EntityEdge"
  ADD CONSTRAINT "EntityEdge_evidence_nonempty"
  CHECK (cardinality("evidenceObservationIds") > 0);

ALTER TABLE "EntityEdge"
  ADD CONSTRAINT "EntityEdge_valid_window"
  CHECK ("validUntil" IS NULL OR "validUntil" > "validFrom");

-- ── basis points are 0–10000, always ──────────────────────────────────────
ALTER TABLE "Observation"   ADD CONSTRAINT "Observation_confidence_bp"   CHECK ("confidenceBp" IS NULL OR ("confidenceBp" BETWEEN 0 AND 10000));
ALTER TABLE "EntityMember"  ADD CONSTRAINT "EntityMember_score_bp"       CHECK ("scoreBp" BETWEEN 0 AND 10000);
ALTER TABLE "EntityEdge"    ADD CONSTRAINT "EntityEdge_confidence_bp"    CHECK ("confidenceBp" BETWEEN 0 AND 10000);
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_score_bp"      CHECK ("scoreBp" IS NULL OR ("scoreBp" BETWEEN 0 AND 10000));
ALTER TABLE "ResolutionRun" ADD CONSTRAINT "ResolutionRun_band_open"     CHECK ("matchThresholdBp" > "reviewThresholdBp");
ALTER TABLE "BiometricComparison" ADD CONSTRAINT "BiometricComparison_threshold_bp" CHECK ("thresholdBp" BETWEEN 0 AND 10000);

-- ── immutability, reusing the v1 trigger function ─────────────────────────
-- Append-only: audit of reads, every pairwise decision, every biometric
-- comparison, every adjudication.
CREATE TRIGGER "AccessLog_no_update"           BEFORE UPDATE ON "AccessLog"           FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "AccessLog_no_delete"           BEFORE DELETE ON "AccessLog"           FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "MatchDecision_no_update"       BEFORE UPDATE ON "MatchDecision"       FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "MatchDecision_no_delete"       BEFORE DELETE ON "MatchDecision"       FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "BiometricComparison_no_update" BEFORE UPDATE ON "BiometricComparison" FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "BiometricComparison_no_delete" BEFORE DELETE ON "BiometricComparison" FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "Adjudication_no_update"        BEFORE UPDATE ON "Adjudication"        FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "Adjudication_no_delete"        BEFORE DELETE ON "Adjudication"        FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();

-- Observations are immutable in content. Deletion is left to retention.
CREATE TRIGGER "Observation_no_update"         BEFORE UPDATE ON "Observation"         FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();

-- Memberships and edges are superseded, never deleted.
CREATE TRIGGER "EntityMember_no_delete"        BEFORE DELETE ON "EntityMember"        FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
CREATE TRIGGER "EntityEdge_no_delete"          BEFORE DELETE ON "EntityEdge"          FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();
