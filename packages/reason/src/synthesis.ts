import { z } from "zod";

import type { Execution, Node, StepResult } from "./executor.js";
import { parseJsonReply, type ModelClient } from "./model.js";
import type { QueryPlan } from "./plan.js";
import type { Refusal } from "./refusal.js";

/**
 * Synthesis: results into an answer whose every claim cites evidence.
 *
 * The rule synthesiser composes claims directly from step results, one per
 * fact, each carrying the observation ids behind it. When a synthesis model
 * is configured it may write the prose instead, but it writes claims, not
 * paragraphs, and each claim's citations are checked against the evidence
 * the executor actually produced: a citation that isn't in that set is
 * dropped, a claim with no citation left is dropped, and an answer with no
 * claim left is "insufficient evidence". The model cannot cite what the
 * graph did not return.
 */

export interface Claim {
  text: string;
  /** Observation ids this claim rests on. Empty only for `basis: "collection-log"`. */
  observationIds: string[];
  /** Observations: what was observed. Collection log: what was asked of which source. */
  basis: "observations" | "collection-log";
  sourceIds?: string[];
  /** Entity ids the claim is about, so a console can select them. */
  entityIds?: string[];
}

export interface Answer {
  status: "answered" | "insufficient-evidence" | "refused";
  text: string;
  claims: Claim[];
  /** Every observation id cited anywhere in the answer. */
  citations: string[];
  refusal: Refusal | null;
  synthesizedBy: "rules" | "model" | null;
}

const bp = (n: number) => `${n.toLocaleString("en-US").replace(/,/g, " ")} bp`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const basisWords = (basis: string | null) =>
  basis === null
    ? ""
    : basis
        .replace(/^shared:(\w+)$/, (_, k: string) => `shared ${k.toLowerCase().replace("_", " ")}`)
        .replace(/^co-location:(\d+)m\/(\d+)min$/, (_, m: string, min: string) => `within ${m} m and ${min} min`)
        .replace(/^asserted$/, "asserted by an analyst");

/** Claims from step results, one fact each, cited. */
export function claimsFromResults(results: readonly StepResult[]): Claim[] {
  const labels = new Map<string, Node>();
  for (const r of results) for (const n of r.nodes) labels.set(n.id, n);
  const name = (id: string) => labels.get(id)?.label ?? id;
  const claims: Claim[] = [];

  for (const r of results) {
    switch (r.op) {
      case "neighbors-of": {
        const root = r.nodes.find((n) => (r.edges.length === 0 ? true : r.edges.some((e) => e.fromEntityId === n.id || e.toEntityId === n.id)));
        for (const e of r.edges) {
          if (e.evidenceObservationIds.length === 0) continue;
          const held = e.validUntil === null ? `since ${day(e.validFrom)}` : `from ${day(e.validFrom)} to ${day(e.validUntil)}`;
          claims.push({
            text: `${name(e.fromEntityId)} is linked to ${name(e.toEntityId)} (${e.relation.toLowerCase().replace(/_/g, " ")}, ${bp(e.confidenceBp)}${e.basis === null ? "" : `, ${basisWords(e.basis)}`}) ${held}.`,
            observationIds: [...e.evidenceObservationIds],
            basis: "observations",
            entityIds: [e.fromEntityId, e.toEntityId],
          });
        }
        if (r.truncated && root !== undefined) {
          claims.push({ text: `The neighbourhood of ${root.label} was cut at the node cap; there are more links than shown.`, observationIds: r.edges.flatMap((e) => e.evidenceObservationIds), basis: "observations", entityIds: [root.id] });
        }
        break;
      }
      case "path-between": {
        if (r.found && r.edges.length > 0) {
          const chain = r.nodes.map((n) => n.label).join(" → ");
          const ids = r.edges.flatMap((e) => e.evidenceObservationIds);
          if (ids.length > 0) claims.push({ text: `${chain}: ${r.edges.length} ${r.edges.length === 1 ? "link" : "links"} (${r.edges.map((e) => e.relation.toLowerCase().replace(/_/g, " ")).join(", ")}).`, observationIds: ids, basis: "observations", entityIds: r.nodes.map((n) => n.id) });
        }
        break;
      }
      case "co-location-window": {
        const subject = r.nodes[0];
        for (const e of r.edges) {
          if (subject === undefined || e.evidenceObservationIds.length === 0) continue;
          const other = e.fromEntityId === subject.id ? e.toEntityId : e.fromEntityId;
          const until = e.validUntil === null ? "open" : e.validUntil.toISOString().slice(0, 16).replace("T", " ") + "Z";
          claims.push({
            text: `${subject.label} was co-located with ${name(other)} (${bp(e.confidenceBp)}${e.basis === null ? "" : `, ${basisWords(e.basis)}`}) from ${e.validFrom.toISOString().slice(0, 16).replace("T", " ")}Z until ${until}.`,
            observationIds: [...e.evidenceObservationIds],
            basis: "observations",
            entityIds: [subject.id, other],
          });
        }
        break;
      }
      case "timeline-for-entity": {
        const subject = r.nodes[0];
        if (subject === undefined) break;
        const observed = r.events.filter((e) => e.kind === "observation" && e.observationId !== undefined);
        if (observed.length > 0) {
          const first = observed[0] as { at: Date };
          const last = observed[observed.length - 1] as { at: Date };
          const sources = [...new Set(observed.map((e) => e.sourceId).filter((s): s is string => s !== undefined))];
          claims.push({
            text: `${subject.label} was observed ${observed.length} ${observed.length === 1 ? "time" : "times"} between ${day(first.at)} and ${day(last.at)} by ${sources.join(", ")}.`,
            observationIds: observed.map((e) => e.observationId as string),
            basis: "observations",
            entityIds: [subject.id],
          });
        }
        for (const e of r.events) {
          if ((e.kind === "edge-start" || e.kind === "edge-end") && (e.evidenceObservationIds?.length ?? 0) > 0) {
            claims.push({ text: `${day(e.at)}: ${e.detail.replace(/^(\w+)/, (rel) => rel.toLowerCase().replace(/_/g, " "))}.`, observationIds: [...(e.evidenceObservationIds ?? [])], basis: "observations", entityIds: e.otherEntityId === undefined ? [subject.id] : [subject.id, e.otherEntityId] });
          }
        }
        break;
      }
      case "sources-consulted": {
        if (r.coverage.length === 0) break;
        const silent = r.coverage.filter((c) => c.observations === 0);
        const spoke = r.coverage.filter((c) => c.observations > 0);
        claims.push({
          text: `${r.coverage.length} ${r.coverage.length === 1 ? "source was" : "sources were"} consulted: ${spoke.map((c) => `${c.sourceId} (${c.observations})`).join(", ") || "none returned anything"}${silent.length > 0 ? `; ${silent.map((c) => c.sourceId).join(", ")} returned nothing` : ""}.`,
          observationIds: [],
          basis: "collection-log",
          sourceIds: r.coverage.map((c) => c.sourceId),
        });
        break;
      }
      case "find-entity":
        break;
    }
  }
  return claims;
}

/**
 * The gate every answer passes through. Citations not in the evidence set
 * are removed; claims left with none are removed; a collection-log claim
 * must name at least one source. What comes back is what may be shown.
 */
export function enforceCitations(claims: readonly Claim[], evidence: ReadonlySet<string>): Claim[] {
  const kept: Claim[] = [];
  for (const claim of claims) {
    if (claim.basis === "collection-log") {
      if ((claim.sourceIds?.length ?? 0) > 0) kept.push({ ...claim, observationIds: [] });
      continue;
    }
    const ids = [...new Set(claim.observationIds)].filter((id) => evidence.has(id));
    if (ids.length > 0) kept.push({ ...claim, observationIds: ids });
  }
  return kept;
}

function assemble(claims: Claim[], text: string | null, by: Answer["synthesizedBy"], insufficient: string): Answer {
  if (claims.length === 0) {
    return { status: "insufficient-evidence", text: insufficient, claims: [], citations: [], refusal: null, synthesizedBy: by };
  }
  const citations = [...new Set(claims.flatMap((c) => c.observationIds))];
  return { status: "answered", text: text ?? claims.map((c) => c.text).join(" "), claims, citations, refusal: null, synthesizedBy: by };
}

const insufficientText = (plan: QueryPlan, results: readonly StepResult[], reference: string): string => {
  const looked = results.filter((r) => r.op === "find-entity").map((r) => r.lookedFor).filter((t): t is string => t !== undefined);
  const subject = looked.length > 0 ? ` about ${looked.map((t) => `"${t}"`).join(" and ")}` : "";
  const ops = [...new Set(plan.steps.map((s) => s.op).filter((op) => op !== "find-entity"))].join(", ");
  return `Insufficient evidence${subject}: the graph under authorization #${reference} holds nothing the ${ops || "plan"} could cite. That is a fact about what has been collected, not about the subject.`;
};

export function synthesizeByRules(plan: QueryPlan, execution: Execution, reference: string): Answer {
  const claims = enforceCitations(claimsFromResults(execution.results), execution.evidence);
  return assemble(claims, null, "rules", insufficientText(plan, execution.results, reference));
}

const modelReplySchema = z.object({
  claims: z.array(z.object({ text: z.string().trim().min(1).max(600), observationIds: z.array(z.string()).default([]) })).max(30),
});

export const SYNTHESIS_SYSTEM = [
  "You write an investigator's answer from evidence you are given. Nothing else.",
  "Reply with JSON only: {\"claims\":[{\"text\":\"...\",\"observationIds\":[\"...\"]}]}.",
  "Every claim must cite observation ids from the evidence list. A claim you cannot cite must not be written.",
  "Plain language, one fact per claim, no speculation, no filler. Say what the evidence says and no more.",
].join("\n");

/**
 * Let a model phrase the answer from the rule-built claims, then gate its
 * citations against the executor's evidence. The model sees only what the
 * graph returned and can only cite that.
 */
export async function synthesizeWithModel(plan: QueryPlan, execution: Execution, reference: string, client: ModelClient): Promise<Answer> {
  const candidates = enforceCitations(claimsFromResults(execution.results), execution.evidence);
  if (candidates.length === 0) return synthesizeByRules(plan, execution, reference);
  const evidence = candidates.map((c, i) => `${i + 1}. ${c.text} [${c.observationIds.join(", ") || `sources: ${c.sourceIds?.join(", ") ?? ""}`}]`).join("\n");
  let reply: unknown;
  try {
    reply = parseJsonReply((await client.complete({ role: "synthesis", system: SYNTHESIS_SYSTEM, user: `Evidence:\n${evidence}\n\nWrite the answer.`, maxTokens: 1_200 })).text);
  } catch {
    // A model that fails to answer does not make the evidence disappear.
    return synthesizeByRules(plan, execution, reference);
  }
  const parsed = modelReplySchema.safeParse(reply);
  if (!parsed.success) return synthesizeByRules(plan, execution, reference);
  const claims = enforceCitations(
    parsed.data.claims.map((c) => ({ text: c.text, observationIds: c.observationIds, basis: "observations" as const })),
    execution.evidence,
  );
  // Collection-log claims have no observation ids for the model to cite; they ride along as the rules wrote them.
  const log = candidates.filter((c) => c.basis === "collection-log");
  const all = [...claims, ...log];
  return assemble(all, all.map((c) => c.text).join(" "), "model", insufficientText(plan, execution.results, reference));
}
