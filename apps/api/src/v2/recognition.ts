import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma, recordAuditEvent } from "@scout/db";
import { ProhibitionError, refuseBiometricIndexing, refuseOpenWorldBiometric, type ScopeContext } from "@scout/scope";

import { HttpError, notFound } from "../errors.js";
import { visibleEntities } from "./graph.js";

/**
 * The custodian side of recognition.
 *
 * The Python service turns media into vectors and ranks vectors; it holds
 * nothing. Everything with legal weight is here: the gallery with its
 * lawful basis, the enrollment with its document reference and expiry, the
 * template encrypted at rest, the comparison logged whether or not it
 * matched, and the refusals, each audited. Media is embedded and discarded;
 * only its hash is written anywhere.
 */

export const RECOGNITION_ENABLED_ENV = "RECOGNITION_ENABLED";
export const TEMPLATE_KEY_ENV = "RECOGNITION_TEMPLATE_KEY";

export function recognitionEnabled(): boolean {
  return (process.env[RECOGNITION_ENABLED_ENV] ?? "false").trim().toLowerCase() === "true";
}

export function recognitionUrl(): string {
  return (process.env["RECOGNITION_SERVICE_URL"] ?? "http://127.0.0.1:8200").replace(/\/$/, "");
}

/** Distance thresholds in basis points of cosine distance; a match is at or under. Calibrate per deployment. */
export function thresholdBp(modality: "FACE" | "VOICE"): number {
  const raw = process.env[modality === "FACE" ? "RECOGNITION_FACE_THRESHOLD_BP" : "RECOGNITION_VOICE_THRESHOLD_BP"];
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000) return parsed;
  return modality === "FACE" ? 6_000 : 7_500;
}

export function marginBp(): number {
  const parsed = Number(process.env["RECOGNITION_MARGIN_BP"]);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000 ? parsed : 500;
}

// ── templates at rest ──────────────────────────────────────────────────────

function templateKey(): { key: Buffer; keyId: string } | null {
  const raw = process.env[TEMPLATE_KEY_ENV]?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const key = Buffer.from(raw, "hex");
  return { key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 12) };
}

export interface SealedTemplate {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
  dims: number;
}

/** AES-256-GCM over the vector as float32. The vector never touches the database in the clear. */
export function sealTemplate(vector: readonly number[], keyMaterial = templateKey()): SealedTemplate {
  if (keyMaterial === null) {
    throw new HttpError(503, "template-key-missing", `${TEMPLATE_KEY_ENV} is not set to 64 hex characters, so no template can be stored. Nothing was enrolled.`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial.key, iv);
  const plain = Buffer.from(new Float32Array(vector).buffer);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyId: keyMaterial.keyId, dims: vector.length };
}

export function openTemplate(sealed: SealedTemplate, keyMaterial = templateKey()): number[] {
  if (keyMaterial === null) throw new HttpError(503, "template-key-missing", `${TEMPLATE_KEY_ENV} is not set; stored templates cannot be read.`);
  if (keyMaterial.keyId !== sealed.keyId) {
    throw new HttpError(503, "template-key-mismatch", `Template was sealed under key ${sealed.keyId}; the configured key is ${keyMaterial.keyId}. Rotate by re-enrolling.`);
  }
  const decipher = createDecipheriv("aes-256-gcm", keyMaterial.key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  const plain = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  return [...new Float32Array(plain.buffer, plain.byteOffset, sealed.dims)];
}

// ── the service ────────────────────────────────────────────────────────────

const embedResponse = z.object({ model: z.string(), dims: z.number().int().positive(), embedding: z.array(z.number()).min(1), media_hash: z.string() });
const matchOut = z.object({ enrollment_id: z.string(), distance_bp: z.number().int() });
const decisionOut = z.enum(["MATCH", "NO_MATCH", "INDETERMINATE"]);
const compareResponse = z.object({
  model: z.string(),
  probe_hash: z.string(),
  compared: z.number().int(),
  matches: z.array(matchOut),
  decision: decisionOut,
  reason: z.string(),
  speakers: z.array(z.object({ speaker: z.string(), seconds: z.number().nullable(), probe_hash: z.string(), compared: z.number().int(), matches: z.array(matchOut), decision: decisionOut, reason: z.string() })).nullable().optional(),
  diariser: z.string().nullable().optional(),
});

async function callService<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${recognitionUrl()}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
  } catch (caught) {
    throw new HttpError(503, "recognition-unavailable", `The recognition service did not answer: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { detail?: { error?: string; message?: string } };
      if (parsed.detail?.message !== undefined) detail = `${parsed.detail.error ?? "error"}: ${parsed.detail.message}`;
    } catch {
      // Not JSON; the raw text is the detail.
    }
    throw new HttpError(response.status === 422 ? 422 : 503, "recognition-refused", `The recognition service answered ${response.status}. ${detail}`);
  }
  return schema.parse(JSON.parse(text));
}

// ── galleries ──────────────────────────────────────────────────────────────

export const LAWFUL_BASES = ["CONSENT", "COURT_ORDER", "STATUTORY_AUTHORITY", "EMPLOYMENT", "CONTRACT"] as const;

export const gallerySchema = z.object({
  name: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(8).max(2_000),
  custodianOrg: z.string().trim().min(1).max(200),
  lawfulBasis: z.enum(LAWFUL_BASES),
  lawfulBasisDocumentRef: z.string().trim().min(1).max(500),
  reviewDueAt: z.coerce.date(),
  /** The custodian's explicit statement that the basis is on file. Not a default. */
  confirmLawfulBasis: z.literal(true),
});

export async function createGallery(input: z.infer<typeof gallerySchema>, operator: string) {
  if (input.reviewDueAt <= new Date()) throw new HttpError(400, "review-due-in-past", "A gallery's review date must be in the future; it is the date the lawful basis is re-examined.");
  const gallery = await prisma.gallery.create({
    data: {
      name: input.name, purpose: input.purpose, custodianOrg: input.custodianOrg, lawfulBasis: input.lawfulBasis,
      lawfulBasisDocumentRef: input.lawfulBasisDocumentRef, reviewDueAt: input.reviewDueAt, createdBy: operator,
    },
  });
  await recordAuditEvent({ action: "v2.gallery.created", actor: operator, detail: { galleryId: gallery.id, lawfulBasis: gallery.lawfulBasis, documentRef: gallery.lawfulBasisDocumentRef, reviewDueAt: gallery.reviewDueAt } });
  return gallery;
}

// ── enrollment ─────────────────────────────────────────────────────────────

export const enrollSchema = z.object({
  caseId: z.string().min(1),
  entityId: z.string().min(1),
  modality: z.enum(["FACE", "VOICE"]),
  /** The media, base64. Embedded and discarded; its hash is audited. */
  mediaB64: z.string().min(1).max(20_000_000),
  contentType: z.string().trim().min(1).max(100).default("application/octet-stream"),
  origin: z.enum(["consented-upload", "court-ordered", "employment-record", "public-scrape", "open-web"]),
  lawfulBasisDocumentRef: z.string().trim().min(1).max(500),
  expiresAt: z.coerce.date(),
});

async function refuse(action: string, operator: string, caseId: string | null, detail: Record<string, unknown>, error: Error): Promise<never> {
  await recordAuditEvent({ caseId: caseId ?? undefined, action, actor: operator, detail: { ...detail, outcome: "refused", reason: error.message } });
  throw error;
}

export async function enroll(input: { ctx: ScopeContext; operator: string; galleryId: string; body: z.infer<typeof enrollSchema> }) {
  const { ctx, operator, galleryId, body } = input;
  const audit = { galleryId, entityId: body.entityId, modality: body.modality, origin: body.origin, authorizationId: ctx.authorizationId };
  if (!recognitionEnabled()) {
    await refuse("v2.gallery.enrollment", operator, body.caseId, audit, new HttpError(503, "feature-disabled", `Recognition is disabled (${RECOGNITION_ENABLED_ENV}=false). Nothing was enrolled.`));
  }
  // Where the media came from, and whether a document backs it: refused
  // and audited before the gallery is even looked up.
  try {
    refuseBiometricIndexing({ origin: body.origin, lawfulBasisDocumentRef: body.lawfulBasisDocumentRef });
  } catch (caught) {
    if (caught instanceof ProhibitionError) await refuse("v2.gallery.enrollment", operator, body.caseId, audit, caught);
    throw caught;
  }
  const gallery = await prisma.gallery.findUnique({ where: { id: galleryId } });
  if (gallery === null) throw notFound(`Gallery ${galleryId} does not exist.`);
  try {
    refuseOpenWorldBiometric({ galleryId, galleryLawfulBasisRef: gallery.lawfulBasisDocumentRef, context: ctx });
  } catch (caught) {
    if (caught instanceof ProhibitionError) await refuse("v2.gallery.enrollment", operator, body.caseId, audit, caught);
    throw caught;
  }
  if (body.expiresAt <= new Date()) throw new HttpError(400, "expiry-in-past", "An enrollment's expiry must be in the future.");
  const visible = await visibleEntities(ctx, new Date(), [body.entityId]);
  if (!visible.has(body.entityId)) throw notFound(`Entity ${body.entityId} is not known under authorization ${ctx.reference}.`);

  const embedded = await callService("/embed", { gallery_id: galleryId, purpose: "enrollment", modality: body.modality, media_b64: body.mediaB64, content_type: body.contentType }, embedResponse);
  const sealed = sealTemplate(embedded.embedding);
  const { enrollment, template } = await prisma.$transaction(async (tx) => {
    const template = await tx.biometricTemplate.create({
      data: { galleryId, modality: body.modality, dims: sealed.dims, model: embedded.model, ciphertext: new Uint8Array(sealed.ciphertext), iv: new Uint8Array(sealed.iv), tag: new Uint8Array(sealed.tag), keyId: sealed.keyId },
    });
    const enrollment = await tx.galleryEnrollment.create({
      data: { galleryId, entityId: body.entityId, modality: body.modality, templateRef: template.id, enrolledBy: operator, lawfulBasisDocumentRef: body.lawfulBasisDocumentRef, expiresAt: body.expiresAt },
    });
    return { enrollment, template };
  });
  await recordAuditEvent({
    caseId: body.caseId, action: "v2.gallery.enrollment", actor: operator,
    detail: { ...audit, outcome: "ok", enrollmentId: enrollment.id, templateRef: template.id, mediaHash: embedded.media_hash, model: embedded.model, expiresAt: body.expiresAt },
  });
  return { enrollment, model: embedded.model, dims: embedded.dims, mediaHash: embedded.media_hash };
}

export async function revokeEnrollment(input: { galleryId: string; enrollmentId: string; operator: string; reason: string }) {
  const row = await prisma.galleryEnrollment.findFirst({ where: { id: input.enrollmentId, galleryId: input.galleryId } });
  if (row === null) throw notFound(`Enrollment ${input.enrollmentId} is not in gallery ${input.galleryId}.`);
  if (row.revokedAt !== null) return row;
  const updated = await prisma.galleryEnrollment.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  await recordAuditEvent({ action: "v2.gallery.enrollment.revoked", actor: input.operator, detail: { galleryId: input.galleryId, enrollmentId: row.id, reason: input.reason } });
  return updated;
}

// ── comparison ─────────────────────────────────────────────────────────────

export const compareSchema = z.object({
  caseId: z.string().min(1),
  /** Required. There is no comparison without a gallery. */
  galleryId: z.string().min(1),
  modality: z.enum(["FACE", "VOICE"]),
  mediaB64: z.string().min(1).max(20_000_000),
  contentType: z.string().trim().min(1).max(100).default("application/octet-stream"),
  topN: z.number().int().min(1).max(20).default(5),
  /** Voice only: split the probe by speaker; each speaker is its own logged comparison. */
  diarize: z.boolean().default(false),
});

export async function compare(input: { ctx: ScopeContext; operator: string; body: z.infer<typeof compareSchema> }) {
  const { ctx, operator, body } = input;
  const audit = { galleryId: body.galleryId, modality: body.modality, authorizationId: ctx.authorizationId, diarize: body.diarize };
  if (!recognitionEnabled()) {
    await refuse("v2.biometric.comparison", operator, body.caseId, audit, new HttpError(503, "feature-disabled", `Recognition is disabled (${RECOGNITION_ENABLED_ENV}=false). Nothing was compared.`));
  }
  if (body.diarize && body.modality !== "VOICE") throw new HttpError(400, "diarize-voice-only", "Diarisation applies to voice probes only.");
  const gallery = await prisma.gallery.findUnique({ where: { id: body.galleryId } });
  // The three-part gate, in the scope package, audited here: a gallery, a
  // lawful basis on record for it, and an authorization that permits it.
  try {
    refuseOpenWorldBiometric({ galleryId: gallery?.id ?? null, galleryLawfulBasisRef: gallery?.lawfulBasisDocumentRef ?? null, context: ctx });
  } catch (caught) {
    if (caught instanceof ProhibitionError) await refuse("v2.biometric.comparison", operator, body.caseId, audit, caught);
    throw caught;
  }
  if (gallery === null) throw notFound(`Gallery ${body.galleryId} does not exist.`);
  const now = new Date();
  if (gallery.reviewDueAt <= now) {
    await refuse("v2.biometric.comparison", operator, body.caseId, audit, new HttpError(409, "review-overdue", `Gallery "${gallery.name}" was due for lawful-basis review on ${gallery.reviewDueAt.toISOString()}. Comparisons are refused until the custodian records a new review date.`));
  }

  const enrollments = await prisma.galleryEnrollment.findMany({
    where: { galleryId: gallery.id, modality: body.modality, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { enrolledAt: "asc" },
  });
  const templates = await prisma.biometricTemplate.findMany({ where: { id: { in: enrollments.map((e) => e.templateRef) } } });
  const byTemplate = new Map(templates.map((t) => [t.id, t]));
  const candidates = enrollments.flatMap((e) => {
    const t = byTemplate.get(e.templateRef);
    if (t === undefined) return [];
    return [{ enrollment_id: e.id, embedding: openTemplate({ ciphertext: Buffer.from(t.ciphertext), iv: Buffer.from(t.iv), tag: Buffer.from(t.tag), keyId: t.keyId, dims: t.dims }) }];
  });

  const threshold = thresholdBp(body.modality);
  const margin = marginBp();
  const result = await callService(
    "/compare",
    { gallery_id: gallery.id, authorization_id: ctx.authorizationId, modality: body.modality, probe_media_b64: body.mediaB64, content_type: body.contentType, candidates, threshold_bp: threshold, margin_bp: margin, top_n: body.topN, diarize: body.diarize },
    compareResponse,
  );

  const byEnrollment = new Map(enrollments.map((e) => [e.id, e]));
  const allMatches = [...result.matches, ...(result.speakers ?? []).flatMap((s) => s.matches)];
  const entityIds = [...new Set(allMatches.map((m) => byEnrollment.get(m.enrollment_id)?.entityId).filter((id): id is string => id !== undefined))];
  const labels = await visibleEntities(ctx, now, entityIds);
  const describe = (matches: Array<{ enrollment_id: string; distance_bp: number }>) =>
    matches.map((m) => {
      const e = byEnrollment.get(m.enrollment_id);
      const entity = e === undefined ? undefined : labels.get(e.entityId);
      return { enrollmentId: m.enrollment_id, entityId: e?.entityId ?? null, label: entity?.label ?? null, kind: entity?.kind ?? null, distanceBp: m.distance_bp, withinThreshold: m.distance_bp <= threshold };
    });

  // Logged whether or not it matched, before the answer leaves. A diarised
  // probe is one row per speaker: each speaker was compared, so each is a
  // comparison, with its own probe hash.
  const units = result.speakers === null || result.speakers === undefined
    ? [{ speaker: null as string | null, seconds: null as number | null, probe_hash: result.probe_hash, compared: result.compared, matches: result.matches, decision: result.decision, reason: result.reason }]
    : result.speakers.map((s) => ({ ...s, speaker: s.speaker as string | null }));
  const rows = [];
  for (const unit of units) {
    const row = await prisma.biometricComparison.create({
      data: {
        probeHash: unit.probe_hash, galleryId: gallery.id, authorizationId: ctx.authorizationId, modality: body.modality,
        topMatches: unit.matches.map((m) => ({ enrollmentId: m.enrollment_id, distanceBp: m.distance_bp, ...(unit.speaker === null ? {} : { speaker: unit.speaker }) })),
        thresholdBp: threshold, decision: unit.decision, requestedBy: operator,
      },
    });
    await recordAuditEvent({
      caseId: body.caseId, action: "v2.biometric.comparison", actor: operator,
      detail: { ...audit, outcome: "ok", comparisonId: row.id, probeHash: unit.probe_hash, decision: unit.decision, compared: unit.compared, model: result.model, speaker: unit.speaker, diariser: result.diariser ?? null },
    });
    rows.push({ row, unit });
  }
  const lead = rows[0] as (typeof rows)[number];

  return {
    comparisonId: lead.row.id,
    comparisonIds: rows.map((r) => r.row.id),
    galleryId: gallery.id,
    modality: body.modality,
    probeHash: result.probe_hash,
    compared: result.compared,
    thresholdBp: threshold,
    marginBp: margin,
    decision: result.decision,
    reason: result.reason,
    model: result.model,
    diariser: result.diariser ?? null,
    matches: describe(result.matches),
    speakers: result.speakers === null || result.speakers === undefined
      ? null
      : rows.map(({ row, unit }) => ({ comparisonId: row.id, speaker: unit.speaker, seconds: unit.seconds, probeHash: unit.probe_hash, compared: unit.compared, decision: unit.decision, reason: unit.reason, matches: describe(unit.matches) })),
  };
}
