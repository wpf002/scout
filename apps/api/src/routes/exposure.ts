import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subjectSchema } from "@scout/sources";
import { jsonSafe } from "@scout/db";
import { hibpSource, queryHibp } from "../adapters/hibp.js";
import { badRequest } from "../errors.js";
import { config } from "../config.js";

const executeSchema = z.object({
  /** Required. A scoped source has no meaning outside a case. */
  caseId: z.string().min(1),
  subject: subjectSchema,
  /**
   * One confirmed action at a time. There is no array here and no batch
   * variant — scoped sources are never fanned out (locked invariant 2).
   */
  confirm: z.literal(true, {
    errorMap: () => ({
      message:
        "confirm must be true — running a scoped source is an explicit, per-subject action.",
    }),
  }),
});

export async function registerExposureRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * POST /exposure/hibp — breach exposure for one account.
   *
   * The scope gate runs inside the adapter, not here. This handler could be
   * deleted and replaced and the guarantee would still hold.
   */
  app.post("/exposure/hibp", async (request) => {
    const body = executeSchema.parse(request.body);

    if (!hibpSource.accepts.includes(body.subject.kind)) {
      throw badRequest(
        `HIBP accepts ${hibpSource.accepts.join(" or ")} subjects, not ${body.subject.kind}.`,
      );
    }

    const result = await queryHibp({
      caseId: body.caseId,
      subject: body.subject,
      operator: config.SCOUT_OPERATOR,
    });

    // BigInt pwn counts do not survive JSON.stringify; jsonSafe renders them
    // as decimal strings rather than lossy numbers.
    return jsonSafe(result);
  });
}
