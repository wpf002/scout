-- The agentic layer: proposals, single-use approvals, graph monitors, alerts.
CREATE TYPE "AgentTier" AS ENUM ('OBSERVE', 'PREPARE', 'CONSEQUENTIAL');
CREATE TYPE "ProposalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'EXECUTED', 'REJECTED', 'REFUSED');
CREATE TYPE "GraphMonitorKind" AS ENUM ('CO_LOCATION', 'NEW_OBSERVATIONS', 'MEMBERSHIP_CHANGE');

CREATE TABLE "AgentProposal" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tier" "AgentTier" NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "citations" TEXT[],
    "requiresScope" JSONB NOT NULL,
    "affects" JSONB NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentProposal_caseId_status_createdAt_idx" ON "AgentProposal"("caseId", "status", "createdAt");
CREATE INDEX "AgentProposal_authorizationId_idx" ON "AgentProposal"("authorizationId");

CREATE TABLE "AgentApproval" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL,
    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AgentApproval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "AgentProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "AgentApproval_proposalId_usedAt_idx" ON "AgentApproval"("proposalId", "usedAt");
-- An approval is a record: it is never deleted.
CREATE TRIGGER "AgentApproval_no_delete" BEFORE DELETE ON "AgentApproval" FOR EACH ROW EXECUTE FUNCTION scout_reject_audit_mutation();

CREATE TABLE "GraphMonitor" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "kind" "GraphMonitorKind" NOT NULL,
    "name" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastState" JSONB,
    CONSTRAINT "GraphMonitor_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GraphMonitor_caseId_disabledAt_idx" ON "GraphMonitor"("caseId", "disabledAt");
CREATE INDEX "GraphMonitor_authorizationId_idx" ON "GraphMonitor"("authorizationId");

CREATE TABLE "GraphAlert" (
    "id" TEXT NOT NULL,
    "monitorId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "observationIds" TEXT[],
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    CONSTRAINT "GraphAlert_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GraphAlert_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "GraphMonitor"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "GraphAlert_caseId_at_idx" ON "GraphAlert"("caseId", "at");
CREATE INDEX "GraphAlert_monitorId_at_idx" ON "GraphAlert"("monitorId", "at");
