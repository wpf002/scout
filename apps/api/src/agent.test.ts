import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";
import { refuseAutonomousConsequential } from "@scout/scope";

import { clearWebhookCalls, webhookCalls } from "./test/network.js";
import { needsApproval, tierOf } from "./agent/tiers.js";

/**
 * The bounded loop: observe, propose, approve, execute. What runs on its
 * own is decided by the tier and AGENT_MAX_AUTONOMOUS_TIER; what needs a
 * human needs one approval per run, spent on use, expiring, and never able
 * to widen scope. Monitors watch inside an authorization and stop with it.
 */

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const get = (url: string) => app.inject({ method: "GET", url });
const REF = `AGENT-${Date.now()}`;
const day = 86_400_000;

run("the agentic layer", () => {
  let caseId: string;
  let authorizationId: string;
  let obsA: string;
  let entityA: string;

  beforeAll(async () => {
    process.env["AGENT_MAX_AUTONOMOUS_TIER"] = "observe";
    process.env["AGENT_APPROVAL_WEBHOOK"] = "https://hooks.example/agent";
    delete process.env["AGENT_DELIVERY_WEBHOOK"];
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();
    const c = await post("/cases", { name: "agent", authorizationRef: REF, scope: [{ kind: "domain", value: "example.org" }] });
    caseId = c.json().id;
    const auth = await post(`/cases/${caseId}/authorization`, { issuedBy: "vitest", sourceClasses: ["FIRST_PARTY", "OPEN_WEB", "SENSOR"], actionClasses: ["COLLECT", "READ_GRAPH", "RESOLVE"], entityKinds: ["DEVICE", "PERSON", "ORG", "VESSEL"], validUntil: new Date(Date.now() + 30 * day).toISOString(), confirmAuthorized: true });
    authorizationId = auth.json().id;
    const collected = await post("/v2/collect", { caseId, collectorId: "first-party-telemetry", params: { consentRef: "C-1", deviceId: "truck-1", label: "Truck One", points: [{ at: "2026-09-13T10:00:00Z", lon: 5, lat: 60 }] } });
    obsA = collected.json().observationIds[0];
    const resolved = (await post("/v2/resolve", { caseId, entityKind: "DEVICE" })).json();
    entityA = resolved.entities[0].id;
    clearWebhookCalls();
  });

  afterAll(async () => {
    delete process.env["AGENT_MAX_AUTONOMOUS_TIER"];
    delete process.env["AGENT_APPROVAL_WEBHOOK"];
    await app?.close();
    await prisma.$disconnect();
  });

  it("classifies every act into a tier, and only observe runs alone by default", () => {
    expect(tierOf("draft-report")).toBe("prepare");
    expect(tierOf("dispatch-collection")).toBe("consequential");
    expect(needsApproval("observe")).toBe(false);
    expect(needsApproval("prepare")).toBe(true);
    expect(needsApproval("consequential")).toBe(true);
    process.env["AGENT_MAX_AUTONOMOUS_TIER"] = "prepare";
    expect(needsApproval("prepare")).toBe(false);
    expect(needsApproval("consequential")).toBe(true);
    process.env["AGENT_MAX_AUTONOMOUS_TIER"] = "observe";
  });

  it("requires evidence for anything above observe, from this authorization", async () => {
    const uncited = await post("/v2/agent/proposals", { caseId, kind: "draft-report", title: "Draft it", rationale: "A report would help the reviewer." });
    expect(uncited.statusCode).toBe(400);
    expect(uncited.json().code ?? uncited.json().error).toBe("citation-required");
    const foreign = await post("/v2/agent/proposals", { caseId, kind: "draft-report", title: "Draft it", rationale: "A report would help the reviewer.", citations: ["obs_not_ours"] });
    expect(foreign.statusCode).toBe(400);
    expect(await prisma.agentProposal.count({ where: { caseId } })).toBe(0);
  });

  it("refuses a consequential act with no approval as a prohibition, audited, and the approval webhook was told about the proposal", async () => {
    const proposed = await post("/v2/agent/proposals", {
      caseId, kind: "dispatch-collection", title: "Fetch example.org", rationale: "The page may publish contact details for the org behind the device.", citations: [obsA],
      requiresScope: { sourceClasses: ["OPEN_WEB"] }, affects: { upstream: "example.org" }, params: { collectorId: "open-web", subject: { kind: "domain", value: "example.org" } },
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    expect(proposed.json().tier).toBe("CONSEQUENTIAL");
    const hook = webhookCalls().find((w) => (w.body as { proposalId?: string }).proposalId === id);
    expect(hook).toBeDefined();
    expect((hook?.body as { event: string; kind: string }).event).toBe("proposal");
    expect((hook?.body as { kind: string }).kind).toBe("dispatch-collection");

    const attempt = await post(`/v2/agent/proposals/${id}/execute`, { caseId });
    expect(attempt.statusCode).toBe(403);
    expect(attempt.json().prohibition).toBe("AUTONOMOUS_CONSEQUENTIAL_ACTION");
    const refused = await prisma.auditEvent.findFirst({ where: { caseId, action: "v2.prohibition.refused" }, orderBy: { createdAt: "desc" } });
    expect((refused?.detail as { prohibition: string }).prohibition).toBe("AUTONOMOUS_CONSEQUENTIAL_ACTION");
    expect((await prisma.agentProposal.findUnique({ where: { id } }))?.status).toBe("PROPOSED");
  });

  it("executes under one recorded approval, spends it, and refuses a second run", async () => {
    const proposal = await prisma.agentProposal.findFirstOrThrow({ where: { caseId, kind: "dispatch-collection" } });
    const approved = await post(`/v2/agent/proposals/${proposal.id}/approve`, { caseId, ttlMinutes: 30, note: "Approved: the domain is inside the boundary." });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().usedAt).toBeNull();
    const again = await post(`/v2/agent/proposals/${proposal.id}/approve`, { caseId, note: "twice" });
    expect(again.statusCode).toBe(409);

    const executed = await post(`/v2/agent/proposals/${proposal.id}/execute`, { caseId });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe("EXECUTED");
    expect(executed.json().result.status).toBe("ok");
    expect(executed.json().result.written).toBe(1);
    const approval = await prisma.agentApproval.findFirstOrThrow({ where: { proposalId: proposal.id } });
    expect(approval.usedAt).not.toBeNull();
    const event = await prisma.auditEvent.findFirst({ where: { caseId, action: "v2.agent.executed" }, orderBy: { createdAt: "desc" } });
    expect((event?.detail as { approvedBy: string; external: boolean }).approvedBy).toBe(approval.approvedBy);
    expect((event?.detail as { external: boolean }).external).toBe(true);
    // The collection itself was audited under the approving run.
    const ran = await prisma.auditEvent.findFirst({ where: { caseId, action: "v2.collection.ran" }, orderBy: { createdAt: "desc" } });
    expect(ran?.actor).toContain(proposal.id);

    const twice = await post(`/v2/agent/proposals/${proposal.id}/execute`, { caseId });
    expect(twice.statusCode).toBe(409);
    // An approval cannot be deleted from the record.
    await expect(prisma.agentApproval.delete({ where: { id: approval.id } })).rejects.toThrow();
  });

  it("refuses an expired approval, and one for another proposal, at the guard", () => {
    const now = new Date();
    const base = { proposalId: "p1", approvedBy: "x", approvedAt: now, usedAt: null };
    expect(() => refuseAutonomousConsequential({ proposalId: "p1", tier: "consequential", approval: { ...base, expiresAt: new Date(now.getTime() - 1) } }, now)).toThrow(/expired/);
    expect(() => refuseAutonomousConsequential({ proposalId: "p1", tier: "consequential", approval: { ...base, proposalId: "p2", expiresAt: new Date(now.getTime() + 60_000) } }, now)).toThrow(/not transferable/);
    expect(() => refuseAutonomousConsequential({ proposalId: "p1", tier: "consequential", approval: { ...base, usedAt: now, expiresAt: new Date(now.getTime() + 60_000) } }, now)).toThrow(/single-use/);
  });

  it("cannot widen scope with an approval: a dispatch outside the boundary is refused before the approval is spent", async () => {
    const proposed = await post("/v2/agent/proposals", {
      caseId, kind: "dispatch-collection", title: "Fetch elsewhere.example", rationale: "Curiosity.", citations: [obsA],
      params: { collectorId: "open-web", subject: { kind: "domain", value: "elsewhere.example" } },
    });
    const id = proposed.json().id as string;
    await post(`/v2/agent/proposals/${id}/approve`, { caseId, note: "approved anyway" });
    const attempt = await post(`/v2/agent/proposals/${id}/execute`, { caseId });
    expect(attempt.statusCode).toBe(403);
    expect(attempt.json().reason).toBe("out-of-scope");
    const approval = await prisma.agentApproval.findFirstOrThrow({ where: { proposalId: id } });
    expect(approval.usedAt).toBeNull();
    expect((await prisma.agentProposal.findUnique({ where: { id } }))?.status).toBe("APPROVED");
  });

  it("runs a prepare act on its own only when the environment allows it", async () => {
    const proposed = await post("/v2/agent/proposals", { caseId, kind: "draft-report", title: "Draft the report", rationale: "For the reviewer.", citations: [obsA] });
    const id = proposed.json().id as string;
    const gated = await post(`/v2/agent/proposals/${id}/execute`, { caseId });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().code ?? gated.json().error).toBe("approval-required");
    process.env["AGENT_MAX_AUTONOMOUS_TIER"] = "prepare";
    try {
      const ran = await post(`/v2/agent/proposals/${id}/execute`, { caseId });
      expect(ran.statusCode).toBe(200);
      expect(ran.json().result.external).toBe(false);
      expect(ran.json().result.bytes).toBeGreaterThan(100);
    } finally {
      process.env["AGENT_MAX_AUTONOMOUS_TIER"] = "observe";
    }
  });

  it("refuses an act that has nowhere to go without spending the approval, and records a scope request without changing the authorization", async () => {
    const send = await post("/v2/agent/proposals", { caseId, kind: "send-report", title: "Send the report", rationale: "The client asked.", citations: [obsA], params: { recipient: "client@example.org" } });
    const sendId = send.json().id as string;
    await post(`/v2/agent/proposals/${sendId}/approve`, { caseId, note: "ok" });
    const nowhere = await post(`/v2/agent/proposals/${sendId}/execute`, { caseId });
    expect(nowhere.statusCode).toBe(409);
    expect((await prisma.agentApproval.findFirstOrThrow({ where: { proposalId: sendId } })).usedAt).toBeNull();

    const before = await prisma.authorization.findUniqueOrThrow({ where: { id: authorizationId } });
    const widen = await post("/v2/agent/proposals", { caseId, kind: "request-scope-expansion", title: "Ask for VESSEL coverage", rationale: "The device travels by sea.", citations: [obsA], params: { requested: { entityKinds: ["VESSEL"] }, justification: "The truck boards a ferry weekly." } });
    const widenId = widen.json().id as string;
    await post(`/v2/agent/proposals/${widenId}/approve`, { caseId, note: "send it to the issuer" });
    const recorded = await post(`/v2/agent/proposals/${widenId}/execute`, { caseId });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().result.authorizationChanged).toBe(false);
    const after = await prisma.authorization.findUniqueOrThrow({ where: { id: authorizationId } });
    expect(after.boundary).toEqual(before.boundary);
    expect(after.actionClasses).toEqual(before.actionClasses);
    expect(await prisma.auditEvent.count({ where: { caseId, action: "v2.agent.scope-expansion.requested" } })).toBe(1);
    expect(webhookCalls().some((w) => (w.body as { event: string }).event === "scope-expansion")).toBe(true);
  });

  it("watches new observations, alerts with the evidence, and proposes a package on its own", async () => {
    const created = await post("/v2/agent/monitors", { caseId, kind: "NEW_OBSERVATIONS", name: "Truck One activity", params: { entityId: entityA } });
    expect(created.statusCode).toBe(201);
    const quiet = await post("/v2/agent/tick", {});
    expect(quiet.json().alerted).toBe(0);

    await post("/v2/collect", { caseId, collectorId: "first-party-telemetry", params: { consentRef: "C-1", deviceId: "truck-1", label: "Truck One", points: [{ at: "2026-09-13T11:00:00Z", lon: 5.1, lat: 60.1 }] } });
    await post("/v2/resolve", { caseId, entityKind: "DEVICE" });
    const tick = await post("/v2/agent/tick", {});
    expect(tick.json().alerted).toBe(1);
    expect(tick.json().proposed).toBe(1);
    const alerts = (await get(`/v2/agent/alerts?caseId=${caseId}`)).json();
    expect(alerts.count).toBe(1);
    expect(alerts.alerts[0].observationIds.length).toBeGreaterThan(0);
    const proposal = await prisma.agentProposal.findFirstOrThrow({ where: { caseId, kind: "assemble-package", proposedBy: "agent" } });
    expect(proposal.tier).toBe("PREPARE");
    expect(proposal.citations.length).toBeGreaterThan(0);
    // Acknowledged alerts stay on the record.
    const ack = await post(`/v2/agent/alerts/${alerts.alerts[0].id}/acknowledge`, { caseId });
    expect(ack.json().acknowledgedAt).not.toBeNull();
  });

  it("watches membership changes and co-location", async () => {
    const membership = await post("/v2/agent/monitors", { caseId, kind: "MEMBERSHIP_CHANGE", name: "Truck One membership", params: { entityId: entityA } });
    expect(membership.statusCode).toBe(201);
    const twoEntities = (await get(`/v2/entities?caseId=${caseId}&kind=DEVICE`)).json().entities as Array<{ id: string }>;
    expect(twoEntities.length).toBeGreaterThanOrEqual(1);
    const bad = await post("/v2/agent/monitors", { caseId, kind: "CO_LOCATION", name: "pair", params: { entityId: entityA } });
    expect(bad.statusCode).toBe(400);
    const unknown = await post("/v2/agent/monitors", { caseId, kind: "CO_LOCATION", name: "pair", params: { entityId: entityA, otherEntityId: "ent_nope" } });
    expect(unknown.statusCode).toBe(404);
  });

  it("does not survive revocation: the next sweep disables the monitor with the reason", async () => {
    const other = await post("/cases", { name: "agent-revoked", authorizationRef: `${REF}-R`, scope: [] });
    const otherId = other.json().id as string;
    await post(`/cases/${otherId}/authorization`, { issuedBy: "vitest", sourceClasses: ["FIRST_PARTY"], actionClasses: ["COLLECT", "READ_GRAPH", "RESOLVE"], entityKinds: ["DEVICE"], validUntil: new Date(Date.now() + 30 * day).toISOString(), confirmAuthorized: true });
    await post("/v2/collect", { caseId: otherId, collectorId: "first-party-telemetry", params: { consentRef: "C-2", deviceId: "van-9", points: [{ at: "2026-09-13T10:00:00Z", lon: 6, lat: 61 }] } });
    const ent = (await post("/v2/resolve", { caseId: otherId, entityKind: "DEVICE" })).json().entities[0].id as string;
    const monitor = (await post("/v2/agent/monitors", { caseId: otherId, kind: "NEW_OBSERVATIONS", name: "Van 9", params: { entityId: ent } })).json();
    await post(`/cases/${otherId}/authorization/revoke`, { reason: "engagement ended" });
    const tick = await post("/v2/agent/tick", {});
    expect(tick.json().disabled).toBe(1);
    const row = await prisma.graphMonitor.findUniqueOrThrow({ where: { id: monitor.id } });
    expect(row.disabledAt).not.toBeNull();
    expect(row.disabledReason).toContain("authorization-revoked");
    expect(await prisma.graphAlert.count({ where: { monitorId: monitor.id } })).toBe(0);
    // And the API refuses to read them under the revoked authorization.
    expect((await get(`/v2/agent/monitors?caseId=${otherId}`)).statusCode).toBe(403);
  });
});
