import { insertObservations, prisma, type ObservationRow } from "@scout/db";
import { createHash } from "node:crypto";

import { LOAD_AUTHORIZATION_ID, LOAD_SOURCE_ID, ensureLoadCase } from "./generate.js";

/**
 * Resolution wall time on a realistic subset: a separate case under the
 * load authorization, with five observations per true person and the
 * kinds of variation the resolver is for (name spelling, email plus tags,
 * missing fields). The run goes through the API route and the real
 * service, so the number is the number an operator would see.
 */

// Enough names that a population of ten thousand collides the way a town
// does, not the way a twelve-by-twelve grid does: blocking on a name that
// thirty people share makes millions of pairs and says nothing about the
// resolver.
const FIRST = ["ana", "ben", "carla", "dev", "erin", "farid", "gia", "hugo", "ines", "jon", "kai", "lena", "marco", "nour", "olu", "pia", "quinn", "rosa", "sam", "tomasz", "uma", "vik", "wen", "xia", "yara", "zed"];
const LAST = ["abara", "berg", "castillo", "diaz", "eriksen", "ferreira", "garcia", "haddad", "ivanova", "jensen", "kim", "lindqvist", "moreau", "nowak", "okafor", "park", "quist", "rahman", "silva", "tanaka", "ueda", "varga", "weber", "xu", "young", "zhou"];
const MIDDLE = "abcdefghijklmnopqrstuvwxyz";

export async function seedResolveSubset(observations: number, log: (line: string) => void = () => undefined): Promise<string> {
  await ensureLoadCase();
  const existing = await prisma.case.findFirst({ where: { authorizationRef: "LOAD-TEST-RESOLVE" } });
  const caseId = existing?.id ?? (await prisma.case.create({ data: { name: "Load Test (resolution subset)", authorizationRef: "LOAD-TEST-RESOLVE", authorizationId: LOAD_AUTHORIZATION_ID, createdBy: "load-test" } })).id;
  const people = Math.ceil(observations / 5);
  let seq = 0;
  let written = 0;
  for (let start = 0; start < people; start += 400) {
    const rows: ObservationRow[] = [];
    const ids: Array<{ observationId: string; kind: "NAME" | "EMAIL" | "PHONE"; value: string; normalizedValue: string; normalizationVersion: string }> = [];
    for (let p = start; p < Math.min(people, start + 400); p += 1) {
      const first = FIRST[p % FIRST.length] as string;
      const last = `${LAST[Math.floor(p / FIRST.length) % LAST.length] as string}-${MIDDLE[Math.floor(p / (FIRST.length * LAST.length)) % MIDDLE.length] as string}`;
      const email = `${first}.${last}${p}@example.net`;
      const phone = `+1415555${String(p % 10_000).padStart(4, "0")}`;
      for (let v = 0; v < 5 && seq < observations; v += 1) {
        seq += 1;
        const name = v === 1 ? `${first.slice(0, 1)} ${last}` : v === 2 ? `${first} ${last.slice(0, -1)}` : `${first} ${last}`;
        const mail = v === 3 ? email.replace("@", "+news@") : v === 4 ? null : email;
        const tel = v % 2 === 0 ? phone : null;
        const normalized = { name, email: mail, phone: tel, seq };
        const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
        const id = `obs_loadres_${hash.slice(0, 20)}`;
        rows.push({ id, sourceId: LOAD_SOURCE_ID, authorizationId: LOAD_AUTHORIZATION_ID, caseId, collectedAt: new Date(), observedAt: new Date(Date.UTC(2026, 5, 1) + (seq % 90) * 86_400_000), rawPayload: null, normalizedPayload: normalized, contentHash: hash, position: null, confidenceBp: null, indeterminate: false, entityKind: "PERSON" });
        ids.push({ observationId: id, kind: "NAME", value: name, normalizedValue: name.toLowerCase(), normalizationVersion: "load-1" });
        if (mail !== null) ids.push({ observationId: id, kind: "EMAIL", value: mail, normalizedValue: mail.toLowerCase(), normalizationVersion: "load-1" });
        if (tel !== null) ids.push({ observationId: id, kind: "PHONE", value: tel, normalizedValue: tel.replace(/\D/g, ""), normalizationVersion: "load-1" });
      }
    }
    const done = new Set(await insertObservations(rows));
    written += done.size;
    const kept = ids.filter((r) => done.has(r.observationId));
    for (let s = 0; s < kept.length; s += 5_000) await prisma.identifier.createMany({ data: kept.slice(s, s + 5_000), skipDuplicates: true });
  }
  log(`resolution subset: ${written.toLocaleString("en-US")} observations for ${people.toLocaleString("en-US")} people in case ${caseId}`);
  return caseId;
}

export async function cleanResolveSubset(): Promise<void> {
  const row = await prisma.case.findFirst({ where: { authorizationRef: "LOAD-TEST-RESOLVE" } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(`DELETE FROM "MatchDecision" WHERE "leftObservationId" LIKE 'obs_loadres_%' OR "rightObservationId" LIKE 'obs_loadres_%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "EntityMember" WHERE "observationId" LIKE 'obs_loadres_%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "Entity" WHERE "id" IN (SELECT e."id" FROM "Entity" e LEFT JOIN "EntityMember" m ON m."entityId" = e."id" WHERE e."resolutionRunId" IN (SELECT "id" FROM "ResolutionRun" WHERE "authorizationId" = '${LOAD_AUTHORIZATION_ID}') AND m."id" IS NULL)`);
    await tx.$executeRawUnsafe(`DELETE FROM "Identifier" WHERE "observationId" LIKE 'obs_loadres_%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "Observation" WHERE "id" LIKE 'obs_loadres_%'`);
    if (row !== null) {
      await tx.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "caseId" = '${row.id}'`);
      await tx.$executeRawUnsafe(`DELETE FROM "Case" WHERE "id" = '${row.id}'`);
    }
  }, { timeout: 600_000 });
}
