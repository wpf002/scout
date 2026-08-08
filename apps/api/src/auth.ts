import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "@scout/db";
import { config, loadConfig } from "./config.js";
import { logEvent } from "./observability.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved operator name, written to every audit row this request makes. */
    operator: string;
    operatorId: string | null;
  }
}

/**
 * Hashes an operator token.
 *
 * SHA-256 rather than a slow KDF, on purpose. Slow hashing exists to make
 * guessing low-entropy secrets expensive; these tokens are 256 bits of CSPRNG
 * output, so there is no guess worth slowing down. Using bcrypt here would add
 * latency to every request and buy nothing.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mints a new operator token. Returned once; only its hash is stored. */
export function mintToken(): string {
  return `scout_${randomBytes(32).toString("hex")}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Routes reachable without a token. Health has to answer to a load balancer. */
const PUBLIC_PATHS = new Set(["/health"]);

/**
 * Resolves the operator for a request.
 *
 * When auth is off (the local single-operator default) every request is
 * attributed to `SCOUT_OPERATOR`. When it is on — the default in production —
 * a valid bearer token is required, and the audit row names the operator that
 * token belongs to rather than a shared label.
 *
 * The audit log's whole value is that it says *who*. A deployment where
 * everything is attributed to "local" answers that question with a shrug,
 * which is why this defaults to required in production rather than opt-in.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  // Resolved when the server is built, not when this module is imported, so
  // the setting reflects the environment the server actually starts in.
  const settings = loadConfig();

  app.decorateRequest("operator", settings.SCOUT_OPERATOR);
  app.decorateRequest("operatorId", null);

  app.addHook("onRequest", async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split("?")[0] ?? "")) return;

    if (!settings.SCOUT_AUTH_REQUIRED) {
      request.operator = settings.SCOUT_OPERATOR;
      request.operatorId = null;
      return;
    }

    const header = request.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7).trim()
        : null;

    if (token === null || token.length === 0) {
      logEvent(request.log, "auth.rejected", { reason: "missing-token" });
      return reply
        .status(401)
        .send({ error: "unauthorized", message: "Bearer token required." });
    }

    const operator = await prisma.operator.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    // Compare the resolved hash in constant time as well. The lookup above is
    // already digest-based, but this keeps the comparison path uniform.
    if (
      operator === null ||
      !constantTimeEquals(operator.tokenHash, hashToken(token))
    ) {
      logEvent(request.log, "auth.rejected", { reason: "unknown-token" });
      return reply
        .status(401)
        .send({ error: "unauthorized", message: "Token not recognized." });
    }

    if (!operator.active) {
      logEvent(request.log, "auth.rejected", {
        reason: "operator-disabled",
        operator: operator.name,
      });
      return reply
        .status(403)
        .send({ error: "forbidden", message: "Operator is disabled." });
    }

    request.operator = operator.name;
    request.operatorId = operator.id;

    // Best effort, and deliberately not awaited into the request path.
    void prisma.operator
      .update({
        where: { id: operator.id },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => undefined);
  });
}

/**
 * The operator to attribute an action to.
 *
 * Every route uses this rather than reading config directly, so turning auth
 * on changes attribution everywhere at once instead of route by route.
 */
export function operatorOf(request: FastifyRequest): string {
  return request.operator ?? config.SCOUT_OPERATOR;
}
