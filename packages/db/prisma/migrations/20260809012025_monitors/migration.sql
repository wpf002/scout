-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('ADDED', 'REMOVED');

-- CreateTable
CREATE TABLE "Monitor" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subjectKind" "SubjectKind" NOT NULL,
    "subjectValue" TEXT NOT NULL,
    "sourceIds" TEXT[],
    "intervalMinutes" INTEGER NOT NULL DEFAULT 1440,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL DEFAULT 'local',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Monitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorRun" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,
    "snapshot" JSONB NOT NULL DEFAULT '[]',
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "MonitorRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitorChange" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "changeType" "ChangeType" NOT NULL,
    "observationKind" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "sourceIds" TEXT[],
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Monitor_caseId_idx" ON "Monitor"("caseId");

-- CreateIndex
CREATE INDEX "Monitor_enabled_lastRunAt_idx" ON "Monitor"("enabled", "lastRunAt");

-- CreateIndex
CREATE INDEX "MonitorRun_monitorId_startedAt_idx" ON "MonitorRun"("monitorId", "startedAt");

-- CreateIndex
CREATE INDEX "MonitorChange_caseId_acknowledgedAt_idx" ON "MonitorChange"("caseId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "MonitorChange_monitorId_createdAt_idx" ON "MonitorChange"("monitorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Monitor" ADD CONSTRAINT "Monitor_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorRun" ADD CONSTRAINT "MonitorRun_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorChange" ADD CONSTRAINT "MonitorChange_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitorChange" ADD CONSTRAINT "MonitorChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MonitorRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
