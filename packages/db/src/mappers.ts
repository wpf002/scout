import type { SubjectKind, Tier } from "@scout/sources";
import type { ScopeEntry, ScopeKind } from "@scout/scope";
import {
  ScopeKind as PrismaScopeKind,
  SubjectKind as PrismaSubjectKind,
  Tier as PrismaTier,
  type ScopeEntry as PrismaScopeEntry,
} from "@prisma/client";

/**
 * Prisma enums are SCREAMING_CASE; the domain packages use lowercase string
 * unions. These mappers are the only place the two representations meet, so a
 * mismatch surfaces here rather than as a silent `undefined` in the gate.
 */

export function toPrismaTier(tier: Tier): PrismaTier {
  return tier.toUpperCase() as PrismaTier;
}

export function fromPrismaTier(tier: PrismaTier): Tier {
  return tier.toLowerCase() as Tier;
}

export function toPrismaSubjectKind(kind: SubjectKind): PrismaSubjectKind {
  return kind.toUpperCase() as PrismaSubjectKind;
}

export function fromPrismaSubjectKind(kind: PrismaSubjectKind): SubjectKind {
  return kind.toLowerCase() as SubjectKind;
}

export function toPrismaScopeKind(kind: ScopeKind): PrismaScopeKind {
  return kind.toUpperCase() as PrismaScopeKind;
}

export function fromPrismaScopeKind(kind: PrismaScopeKind): ScopeKind {
  return kind.toLowerCase() as ScopeKind;
}

/** Converts a stored scope row into the shape the pure gate consumes. */
export function toScopeEntry(row: PrismaScopeEntry): ScopeEntry {
  return {
    id: row.id,
    kind: fromPrismaScopeKind(row.kind),
    value: row.value,
  };
}

/**
 * Makes a value safe to hand to `JSON.stringify`, which throws on BigInt.
 * Counts are stored and transmitted as decimal strings so no precision is lost
 * on the way through JSON.
 */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        jsonSafe(v),
      ]),
    );
  }
  return value;
}
