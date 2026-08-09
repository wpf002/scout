/**
 * Seeds one demonstration case.
 *
 * Everything here uses RFC 2606 reserved names (`example.com`, `example.org`)
 * so the seed can never point a scoped source at a real person or a real
 * domain. Do not replace these with live values.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const existing = await prisma.case.findFirst({
    where: { authorizationRef: "DEMO-ENGAGEMENT-0001" },
  });
  if (existing !== null) {
    console.log(`Seed case already present: ${existing.id}`);
    return;
  }

  const demo = await prisma.case.create({
    data: {
      name: "Demo engagement — example.com",
      authorizationRef: "DEMO-ENGAGEMENT-0001",
      notes:
        "Seeded demonstration case. Scope uses RFC 2606 reserved names only.",
      createdBy: "seed",
      scopeEntries: {
        create: [
          {
            kind: "DOMAIN",
            value: "example.com",
            note: "Primary authorized domain (and its subdomains).",
            addedBy: "seed",
          },
          {
            kind: "IDENTIFIER",
            value: "alice@example.org",
            note: "Single authorized identifier outside the domain scope.",
            addedBy: "seed",
          },
        ],
      },
      subjects: {
        create: [
          { kind: "DOMAIN", value: "example.com", label: "Primary domain" },
          { kind: "EMAIL", value: "alice@example.org", label: "Named contact" },
        ],
      },
    },
    include: { scopeEntries: true, subjects: true },
  });

  await prisma.auditEvent.create({
    data: {
      caseId: demo.id,
      action: "case.created",
      actor: "seed",
      detail: {
        source: "prisma/seed.ts",
        scopeEntryCount: demo.scopeEntries.length,
      },
    },
  });

  /**
   * Findings, so the case is not an empty room.
   *
   * A seed that creates a case with nothing in it leaves Findings, Graph and
   * Timeline all blank on first run, which reads as broken rather than as new.
   * Two sources report the same four hostnames, because corroboration is the
   * thing the graph exists to show and one source cannot demonstrate it.
   */
  const hosts = ["www", "mail", "vpn", "api"];
  const reporters = [
    { sourceId: "crtsh", note: "certificate transparency" },
    { sourceId: "securitytrails", note: "historical DNS" },
  ];

  await prisma.finding.createMany({
    data: hosts.flatMap((host, index) =>
      reporters.map((reporter) => ({
        caseId: demo.id,
        sourceId: reporter.sourceId,
        tier: "INFRA" as const,
        title: `Subdomain ${host}.example.com`,
        summary: `${host}.example.com, via ${reporter.note}.`,
        data: { kind: "subdomain", hostname: `${host}.example.com` },
        queryTerm: "example.com",
        queryKind: "DOMAIN" as const,
        observedAt: new Date(Date.UTC(2026, 7, 2 + index, 10, index * 7)),
        savedBy: "seed",
      })),
    ),
  });

  /**
   * One refusal on the record.
   *
   * The denial is the part that proves the gate ran, so a demonstration case
   * should not open with a spotless log. This row is what the Audit and
   * Timeline tabs are for.
   */
  await prisma.queryLog.create({
    data: {
      caseId: demo.id,
      sourceId: "hibp",
      tier: "EXPOSURE",
      requiresScope: true,
      phase: "EXECUTE",
      outcome: "DENIED",
      reason: "out-of-scope",
      subjectKind: "EMAIL",
      subjectValue: "someone@unrelated.net",
      authorizationRef: demo.authorizationRef,
      operator: "seed",
    },
  });

  console.log(`Seeded case ${demo.id} (${demo.name})`);
  console.log(`  scope entries: ${demo.scopeEntries.length}`);
  console.log(`  subjects:      ${demo.subjects.length}`);
  console.log("");
  console.log("Try it:");
  console.log(
    `  curl -s localhost:3001/query -H 'content-type: application/json' \\`,
  );
  console.log(
    `    -d '{"caseId":"${demo.id}","subject":{"kind":"email","value":"bob@example.com"}}' | jq`,
  );
  console.log("  # then the same with an out-of-scope address:");
  console.log(
    `  curl -s localhost:3001/exposure/hibp -H 'content-type: application/json' \\`,
  );
  console.log(
    `    -d '{"caseId":"${demo.id}","confirm":true,"subject":{"kind":"email","value":"someone@unrelated.net"}}' | jq`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
