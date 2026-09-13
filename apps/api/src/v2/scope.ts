import { ScopeContext, ScopeError } from "@scout/scope";
import { prisma } from "@scout/db";
import { notFound } from "../errors.js";

/**
 * The scope context for a request about a case.
 *
 * v1 loads a case and its scope entries; v2 needs the authorization row the
 * case points at, because collection, resolution and graph reads need a
 * window, an issuer and a permission list that a reference string cannot
 * carry. A case without one can do everything it could before and nothing
 * from v2, and the refusal says how to fix that.
 */
export interface CaseScope {
  ctx: ScopeContext;
  caseId: string;
  caseName: string;
}

export async function scopeContextForCase(
  caseId: string,
  operator: string,
  now: Date = new Date(),
): Promise<CaseScope> {
  const record = await prisma.case.findUnique({
    where: { id: caseId },
    include: { authorization: true },
  });
  if (record === null) throw notFound(`Case ${caseId} does not exist.`);

  if (record.authorization === null) {
    throw new ScopeError(
      "authorization-missing",
      `Case "${record.name}" has no v2 authorization, so it cannot collect, resolve or read the entity graph. ` +
        `Create one with POST /cases/${caseId}/authorization.`,
    );
  }

  return {
    ctx: ScopeContext.build({ authorization: record.authorization, operator, now }),
    caseId: record.id,
    caseName: record.name,
  };
}
