import { parseJsonReply, type ModelClient, ModelError } from "./model.js";
import { MAX_COST, MAX_NEIGHBOR_HOPS, MAX_PATH_HOPS, MAX_STEPS, OPERATIONS, PlanError, validatePlan, type QueryPlan } from "./plan.js";
import { refuse } from "./refusal.js";

/**
 * From a question to a plan.
 *
 * The rule planner goes first. It knows a handful of question shapes and
 * turns each into steps without a model in the loop, which is how Scout
 * answers with REASON_PROVIDER=none and how the tests run. A question the
 * rules don't recognise goes to the model planner when one is configured;
 * its reply must parse as a plan or the question is refused. Either way the
 * plan is validated before anything runs: same schema, same budget.
 */

export interface PlannerContext {
  now: Date;
  authorizationReference: string;
}

export interface Planned {
  plan: QueryPlan;
  plannedBy: "rules" | "model";
  /** The rule that matched, for the trace. */
  shape: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Strip quotes, articles and trailing punctuation from a mentioned name. */
const clean = (text: string): string =>
  text
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’?.!,;:]+$/g, "")
    .replace(/^(the|a|an)\s+/i, "")
    .trim();

function parseDate(text: string, end = false): Date | null {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?Z?)?/.exec(text);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (h === undefined) {
    const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    return end ? new Date(day.getTime() + DAY_MS - 1) : day;
  }
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0")));
}

const hopsIn = (text: string): number => {
  const m = /within\s+(\d+)\s+hops?/i.exec(text);
  return m === null ? 1 : Math.min(MAX_NEIGHBOR_HOPS, Math.max(1, Number(m[1])));
};

interface Shape {
  name: string;
  pattern: RegExp;
  build: (m: RegExpExecArray, question: string, ctx: PlannerContext) => QueryPlan | null;
}

const SHAPES: Shape[] = [
  {
    name: "sources-consulted",
    pattern: /\b(which|what)\s+sources\b|\bsources\s+(were\s+)?(consulted|asked|had)\b|\bcoverage\b/i,
    build: () => ({ steps: [{ id: "s1", op: "sources-consulted" }] }),
  },
  {
    name: "path-between",
    pattern: /\b(?:path|route|connection|link)\s+(?:between|from)\s+(.+?)\s+(?:and|to)\s+(.+?)(?:\s+within\s+\d+\s+hops?)?\s*[?.!]*$|\bhow\s+(?:is|are|was|were)\s+(.+?)\s+(?:connected|linked|related)\s+(?:to|with)\s+(.+?)\s*[?.!]*$/i,
    build: (m) => {
      const a = clean(m[1] ?? m[3] ?? "");
      const b = clean(m[2] ?? m[4] ?? "");
      if (a === "" || b === "") return null;
      const hops = /within\s+(\d+)\s+hops?/i.exec(m[0]);
      return {
        steps: [
          { id: "s1", op: "find-entity", text: a, limit: 1 },
          { id: "s2", op: "find-entity", text: b, limit: 1 },
          { id: "s3", op: "path-between", from: { ref: "s1", index: 0 }, to: { ref: "s2", index: 0 }, maxHops: hops === null ? 4 : Math.min(MAX_PATH_HOPS, Math.max(1, Number(hops[1]))) },
        ],
      };
    },
  },
  {
    name: "co-location-window",
    pattern: /\bwho\s+(?:was|were)\s+(?:near|with|around|close\s+to)\s+(.+?)\s+(?:on|between|from|during)\s+(.+?)\s*[?.!]*$|\bwhere\s+was\s+(.+?)\s+(?:on|between|from|during)\s+(.+?)\s*[?.!]*$/i,
    build: (m) => {
      const who = clean(m[1] ?? m[3] ?? "");
      const when = m[2] ?? m[4] ?? "";
      if (who === "") return null;
      const dates = [...when.matchAll(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?/g)].map((x) => x[0]);
      const from = dates[0] === undefined ? null : parseDate(dates[0]);
      if (from === null) return null;
      const to = dates[1] === undefined ? parseDate(dates[0] as string, true) : parseDate(dates[1], true);
      if (to === null || to <= from) return null;
      return {
        steps: [
          { id: "s1", op: "find-entity", text: who, limit: 1 },
          { id: "s2", op: "co-location-window", entity: { ref: "s1", index: 0 }, from, to },
        ],
      };
    },
  },
  {
    name: "timeline-for-entity",
    pattern: /\b(?:timeline|history)\s+(?:of|for)\s+(.+?)\s*[?.!]*$|\bwhat\s+happened\s+(?:to|with)\s+(.+?)\s*[?.!]*$/i,
    build: (m) => {
      const who = clean(m[1] ?? m[2] ?? "");
      return who === "" ? null : { steps: [{ id: "s1", op: "find-entity", text: who, limit: 1 }, { id: "s2", op: "timeline-for-entity", entity: { ref: "s1", index: 0 } }] };
    },
  },
  {
    name: "neighbors-of",
    pattern: /\bwho\s+(?:is|are|was|were)\s+(?:connected|linked|associated|related)\s+(?:to|with)\s+(.+?)(?:\s+within\s+\d+\s+hops?)?\s*[?.!]*$|\b(?:connections|links|neighbou?rs|associates)\s+of\s+(.+?)(?:\s+within\s+\d+\s+hops?)?\s*[?.!]*$|\bwhat\s+(?:is|are)\s+(.+?)\s+(?:connected|linked)\s+to\s*[?.!]*$/i,
    build: (m, question) => {
      const who = clean(m[1] ?? m[2] ?? m[3] ?? "");
      return who === "" ? null : { steps: [{ id: "s1", op: "find-entity", text: who, limit: 1 }, { id: "s2", op: "neighbors-of", entity: { ref: "s1", index: 0 }, hops: hopsIn(question) }] };
    },
  },
  {
    name: "about-entity",
    pattern: /\b(?:what\s+do\s+we\s+know\s+about|tell\s+me\s+about|who\s+is|what\s+is)\s+(.+?)\s*[?.!]*$/i,
    build: (m) => {
      const who = clean(m[1] ?? "");
      return who === ""
        ? null
        : {
            steps: [
              { id: "s1", op: "find-entity", text: who, limit: 1 },
              { id: "s2", op: "neighbors-of", entity: { ref: "s1", index: 0 }, hops: 1 },
              { id: "s3", op: "timeline-for-entity", entity: { ref: "s1", index: 0 } },
            ],
          };
    },
  },
];

/** The rule planner: a plan, or null when no shape matches. */
export function planByRules(question: string, ctx: PlannerContext): Planned | null {
  const q = question.trim();
  for (const shape of SHAPES) {
    const m = shape.pattern.exec(q);
    if (m === null) continue;
    const plan = shape.build(m, q, ctx);
    if (plan === null) continue;
    return { plan: validatePlan(plan), plannedBy: "rules", shape: shape.name };
  }
  return null;
}

export const PLANNER_SYSTEM = [
  "You turn an investigator's question into a query plan for an entity graph.",
  "You may only choose from these operations, with these parameters:",
  '- find-entity {text, kind?, limit?}: look an entity up by name or identifier. Later steps refer to its matches as {"ref":"s1","index":0}.',
  `- neighbors-of {entity, hops? (1-${MAX_NEIGHBOR_HOPS}), asOf?}: entities linked to one.`,
  `- path-between {from, to, maxHops? (1-${MAX_PATH_HOPS}), asOf?}: the shortest chain of links between two.`,
  "- co-location-window {entity, from, to}: who was near an entity in a time window (ISO dates).",
  "- timeline-for-entity {entity, asOf?}: what happened to an entity, in order.",
  "- sources-consulted {}: which sources were asked and what each returned.",
  `Reply with JSON only: {"steps":[{"id":"s1","op":...}, ...]}. At most ${MAX_STEPS} steps; ids s1, s2, …; total cost at most ${MAX_COST} where neighbors-of costs 1+hops, path-between costs maxHops, co-location-window 2, the rest 1.`,
  "Never write SQL, Cypher or any query text. If the question cannot be answered with these operations, reply {\"steps\":[]}.",
].join("\n");

/**
 * Plan a question: rules first, then the model if there is one. A refusal
 * names the shapes Scout can answer, so the next question can be one of
 * them.
 */
export async function planQuestion(question: string, ctx: PlannerContext, client: ModelClient | null): Promise<Planned> {
  const byRules = planByRules(question, ctx);
  if (byRules !== null) return byRules;

  const shapes = "connections of an entity, the path between two, who was near one in a window, an entity's timeline, what is known about one, and which sources were consulted";
  if (client === null) {
    refuse({
      reason: "cannot-plan",
      message: `Scout could not map that question to a graph operation. Without a planner model (REASON_PROVIDER=none) it answers: ${shapes}.`,
      requires: "A question in one of those shapes, or a planner model configured with REASON_PROVIDER.",
      authorizationReference: ctx.authorizationReference,
    });
  }

  let reply: string;
  try {
    reply = (await client.complete({ role: "planner", system: PLANNER_SYSTEM, user: `Now: ${ctx.now.toISOString()}\nQuestion: ${question}`, maxTokens: 600 })).text;
  } catch (caught) {
    refuse({
      reason: "model-unavailable",
      message: caught instanceof ModelError ? caught.message : "The planner model did not answer.",
      requires: "A reachable planner model, or a question in a shape the rules know.",
      authorizationReference: ctx.authorizationReference,
    });
  }
  let parsed: unknown;
  try {
    parsed = parseJsonReply(reply);
  } catch {
    refuse({ reason: "invalid-plan", message: "The planner model's reply was not a plan.", requires: "A question the planner can express with the permitted operations.", authorizationReference: ctx.authorizationReference });
  }
  const steps = (parsed as { steps?: unknown }).steps;
  if (Array.isArray(steps) && steps.length === 0) {
    refuse({ reason: "cannot-plan", message: `The planner could not express that question with the permitted operations. Scout answers: ${shapes}.`, requires: "A question in one of those shapes.", authorizationReference: ctx.authorizationReference });
  }
  try {
    return { plan: validatePlan(parsed), plannedBy: "model", shape: "model" };
  } catch (caught) {
    refuse({
      reason: "invalid-plan",
      message: caught instanceof PlanError ? caught.message : "The planner model produced an invalid plan.",
      requires: `A plan built only from ${OPERATIONS.join(", ")} within the budget.`,
      authorizationReference: ctx.authorizationReference,
    });
  }
}
