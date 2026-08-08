-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "ScopeKind" AS ENUM ('DOMAIN', 'IDENTIFIER');

-- CreateEnum
CREATE TYPE "SubjectKind" AS ENUM ('DOMAIN', 'IP', 'EMAIL', 'USERNAME', 'PERSON', 'COMPANY', 'HASH', 'KEYWORD');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('DATASETS', 'INFRA', 'EXPOSURE', 'PEOPLE', 'ONION', 'UTILS');

-- CreateEnum
CREATE TYPE "QueryPhase" AS ENUM ('PLAN', 'EXECUTE');

-- CreateEnum
CREATE TYPE "QueryOutcome" AS ENUM ('ALLOWED', 'DENIED', 'INERT', 'ERROR');

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorizationRef" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'local',

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScopeEntry" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "ScopeKind" NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "addedBy" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScopeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "SubjectKind" NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "subjectId" TEXT,
    "sourceId" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "queryTerm" TEXT NOT NULL,
    "queryKind" "SubjectKind" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "queryLogId" TEXT,
    "savedBy" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryLog" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "requiresScope" BOOLEAN NOT NULL,
    "phase" "QueryPhase" NOT NULL,
    "outcome" "QueryOutcome" NOT NULL,
    "reason" TEXT,
    "subjectKind" "SubjectKind" NOT NULL,
    "subjectValue" TEXT NOT NULL,
    "authorizationRef" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'local',
    "matchedScopeEntryId" TEXT,
    "matchedScopeValue" TEXT,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseSource" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "actor" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Case_status_createdAt_idx" ON "Case"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ScopeEntry_caseId_idx" ON "ScopeEntry"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "ScopeEntry_caseId_kind_value_key" ON "ScopeEntry"("caseId", "kind", "value");

-- CreateIndex
CREATE INDEX "Subject_caseId_idx" ON "Subject"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_caseId_kind_value_key" ON "Subject"("caseId", "kind", "value");

-- CreateIndex
CREATE INDEX "Finding_caseId_sourceId_idx" ON "Finding"("caseId", "sourceId");

-- CreateIndex
CREATE INDEX "Finding_caseId_createdAt_idx" ON "Finding"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "QueryLog_caseId_createdAt_idx" ON "QueryLog"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "QueryLog_caseId_sourceId_idx" ON "QueryLog"("caseId", "sourceId");

-- CreateIndex
CREATE INDEX "QueryLog_outcome_createdAt_idx" ON "QueryLog"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "CaseSource_caseId_idx" ON "CaseSource"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseSource_caseId_sourceId_key" ON "CaseSource"("caseId", "sourceId");

-- CreateIndex
CREATE INDEX "AuditEvent_caseId_createdAt_idx" ON "AuditEvent"("caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScopeEntry" ADD CONSTRAINT "ScopeEntry_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_queryLogId_fkey" FOREIGN KEY ("queryLogId") REFERENCES "QueryLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryLog" ADD CONSTRAINT "QueryLog_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSource" ADD CONSTRAINT "CaseSource_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
