import type { FastifyInstance } from "fastify";
import { ProhibitionError, ScopeError } from "@scout/scope";
import { ProvenanceError } from "@scout/fusion";
import { ZodError } from "zod";
import { logEvent } from "./observability.js";
import { auditProhibition } from "./v2/prohibitions.js";

/** A request-level failure with a stable machine-readable code. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const notFound = (message: string) =>
  new HttpError(404, "not-found", message);

export const badRequest = (message: string) =>
  new HttpError(400, "bad-request", message);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    // A scope denial is a first-class, expected outcome — 403 with the stable
    // reason string so the UI can explain exactly why, and so it lines up with
    // the `reason` written to the audit log.
    if (error instanceof ScopeError) {
      // The refusal is the signal worth alerting on. Deliberately no subject
      // term in the fields — a denied lookup is exactly the value that must
      // not be copied into a log aggregator.
      logEvent(request.log, "scope.denied", {
        reason: error.reason,
        sourceId: error.sourceId ?? null,
      });
      return reply.status(403).send({
        error: "scope-denied",
        reason: error.reason,
        message: error.message,
        sourceId: error.sourceId ?? null,
      });
    }

    // A prohibition guard refused an act. Same treatment as a scope denial:
    // a stable code, the guard that fired, and an event worth alerting on.
    if (error instanceof ProhibitionError) {
      logEvent(request.log, "prohibition.refused", {
        prohibition: error.prohibition,
      });
      // On the record before the reply: the attempt, the actor, the route.
      await auditProhibition(request, error);
      return reply.status(403).send({
        error: "prohibited",
        prohibition: error.prohibition,
        message: error.message,
      });
    }

    // An observation arrived without its provenance. Named fields, so the
    // caller fixes the record rather than reading a constraint name.
    if (error instanceof ProvenanceError) {
      return reply.status(422).send({
        error: "provenance-missing",
        missing: error.missing,
        message: error.message,
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "invalid-request",
        message: "Request body failed validation.",
        issues: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    if (error instanceof HttpError) {
      return reply
        .status(error.statusCode)
        .send({ error: error.code, message: error.message });
    }

    // Anything else: a Fastify-thrown error (bad JSON, 404, payload too large)
    // or a genuine bug. Read the shape defensively rather than trusting it.
    const shape = error as { statusCode?: unknown; message?: unknown };
    const statusCode =
      typeof shape.statusCode === "number" ? shape.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error");
      return reply.status(statusCode).send({
        error: "internal-error",
        message: "The request failed. See server logs.",
      });
    }

    return reply.status(statusCode).send({
      error: "request-error",
      message:
        typeof shape.message === "string" ? shape.message : "Request failed.",
    });
  });
}
